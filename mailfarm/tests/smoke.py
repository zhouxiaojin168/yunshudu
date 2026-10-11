"""mailfarm 本地端到端自测：领邮箱 -> 本地投信 -> 轮询取码 -> 鉴权校验。"""
import json
import os
import smtplib
import subprocess
import sys
import time
from email.message import EmailMessage
from pathlib import Path

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
HTTP_PORT = int(os.environ.get("SMOKE_HTTP_PORT", "18099"))
SMTP_PORT = int(os.environ.get("SMOKE_SMTP_PORT", "10025"))
API_KEY = "smoke-key-123"
BASE = "http://127.0.0.1:" + str(HTTP_PORT)

RESULT = {"ok": 0, "fail": 0}


def check(name, cond, extra=""):
    RESULT["ok" if cond else "fail"] += 1
    print("[%s] %s %s" % ("PASS" if cond else "FAIL", name, str(extra)[:160]), flush=True)
    return cond


def wait_health(timeout=25.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            r = httpx.get(BASE + "/healthz", timeout=2.0)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(0.4)
    return None


def send_mail(addr, subject, body):
    m = EmailMessage()
    m["From"] = "noreply@example.com"
    m["To"] = addr
    m["Subject"] = subject
    m.set_content(body)
    with smtplib.SMTP("127.0.0.1", SMTP_PORT, timeout=10) as s:
        s.send_message(m)


def acquire(prefix=None):
    payload = {} if prefix is None else {"prefix": prefix}
    r = httpx.post(BASE + "/v1/mailboxes/acquire", json=payload,
                   headers={"x-api-key": API_KEY}, timeout=10)
    return r.json()


def run_checks(h):
    check("/healthz 返回 domains 清单",
          h.get("domains") == ["allen23.online", "ytu.baby"], h.get("domains"))
    check("/healthz store=memory", h.get("store") == "memory", h.get("store"))

    box = acquire("zz")
    addr = box.get("address", "")
    check("acquire 返回地址", "@" in addr, addr)
    check("acquire 前缀生效", addr.startswith("zz"), addr)

    r = httpx.post(BASE + "/v1/mailboxes/acquire_batch", json={"n": 3},
                   headers={"x-api-key": API_KEY}, timeout=10)
    b = r.json()
    check("acquire_batch n=3", b.get("count") == 3, b.get("count"))

    send_mail(addr, "Your verification code", "您的验证码是 483920，5 分钟内有效。")
    time.sleep(0.7)

    r = httpx.get(BASE + "/v1/mailboxes/" + addr + "/code?timeout=15",
                  headers={"x-api-key": API_KEY}, timeout=25)
    code = r.json().get("code")
    check("取到验证码 483920", code == "483920", code)

    r = httpx.get(BASE + "/v1/mailboxes/" + addr + "/messages?limit=5",
                  headers={"x-api-key": API_KEY}, timeout=10)
    msgs = r.json().get("messages", [])
    check("messages 可读且带 codes", len(msgs) == 1 and msgs[0].get("codes") == ["483920"],
          str(msgs)[:120])

    r = httpx.get(BASE + "/v1/stats", timeout=10)
    check("stats 无 key -> 401 detail=bad api key",
          r.status_code == 401 and r.json().get("detail") == "bad api key", r.status_code)

    r = httpx.get(BASE + "/v1/stats", headers={"x-api-key": API_KEY}, timeout=10)
    st = r.json()
    check("stats 带 key -> 200", r.status_code == 200 and st.get("mailboxes", 0) >= 4,
          json.dumps(st, ensure_ascii=False))

    # 全新邮箱：无信 -> 长轮询应按 timeout 返回 found=false
    fresh = acquire("nk").get("address", "")
    t0 = time.time()
    r = httpx.get(BASE + "/v1/mailboxes/" + fresh + "/code?timeout=2",
                  headers={"x-api-key": API_KEY}, timeout=15)
    dt = time.time() - t0
    check("无码时按 timeout 返回 found=false",
          r.json().get("found") is False and json.loads(json.dumps(r.json()))["code"] is None,
          "耗时 %.2fs / %s" % (dt, r.json()))

    # 中文关键字外的英文 OTP 也能抽
    addr2 = acquire("otp").get("address", "")
    send_mail(addr2, "Login code", "Your one-time password is A7K9Q2. Do not share.")
    time.sleep(0.7)
    r = httpx.get(BASE + "/v1/mailboxes/" + addr2 + "/code?timeout=10",
                  headers={"x-api-key": API_KEY}, timeout=20)
    check("英文 one-time password 抽取", r.json().get("code") == "A7K9Q2", r.json().get("code"))

    r = httpx.get(BASE + "/v1/mailboxes/nobody@nowhere.tld/messages",
                  headers={"x-api-key": API_KEY}, timeout=10)
    check("未知邮箱 -> 404", r.status_code == 404, r.status_code)

    r = httpx.get(BASE + "/openapi.json", timeout=10)
    paths = sorted(r.json().get("paths", {}).keys())
    check("openapi 端点齐全",
          paths == ["/", "/healthz", "/v1/mailboxes/acquire", "/v1/mailboxes/acquire_batch",
                    "/v1/mailboxes/{address}/code", "/v1/mailboxes/{address}/messages", "/v1/stats"], paths)


def main():
    (ROOT / "logs").mkdir(exist_ok=True)
    env = dict(os.environ)
    env.update({
        "MF_API_KEY": API_KEY,
        "MF_DOMAINS": "allen23.online,ytu.baby",
        "MF_HTTP_PORT": str(HTTP_PORT),
        "MF_SMTP_PORT": str(SMTP_PORT),
        "MF_SMTP_HOST": "127.0.0.1",
        "MF_HTTP_HOST": "127.0.0.1",
    })
    py = ROOT / ".venv" / "Scripts" / "python.exe"
    py = str(py) if py.exists() else sys.executable
    logpath = ROOT / "logs" / "smoke-server.log"
    logf = open(logpath, "w", encoding="utf-8")
    proc = subprocess.Popen([py, str(ROOT / "run.py")], cwd=str(ROOT), env=env,
                            stdout=logf, stderr=subprocess.STDOUT)
    rc = 1
    try:
        h = wait_health()
        if not check("启动 /healthz", bool(h), h):
            rc = 1
        else:
            run_checks(h)
            rc = 0 if RESULT["fail"] == 0 else 1
    except Exception as exc:
        print("[FAIL] 异常中断: %s: %s" % (type(exc).__name__, exc), flush=True)
        RESULT["fail"] += 1
        rc = 1
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        logf.close()
    print("---- server log tail ----", flush=True)
    try:
        print(logpath.read_text(encoding="utf-8", errors="replace")[-1800:], flush=True)
    except Exception:
        pass
    print("----", flush=True)
    print("PASS=%d  FAIL=%d" % (RESULT["ok"], RESULT["fail"]), flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
