"""内存邮箱存储（可换 Redis/SQLite）：对齐实测 store=memory 的短生命周期语义。"""
import random
import string
import threading
import time
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

from .codes import extract_codes

_ALPHABET = string.ascii_lowercase + string.digits


@dataclass
class MailMessage:
    ts: float
    sender: str
    rcpt: str
    subject: str
    text: str
    codes: List[str] = field(default_factory=list)

    def brief(self) -> dict:
        d = asdict(self)
        d["body_preview"] = (self.text or "")[:500]
        d.pop("text", None)
        return d


@dataclass
class Mailbox:
    address: str
    domain: str
    created_at: float
    expires_at: float
    messages: List[MailMessage] = field(default_factory=list)


class MailStore:
    """线程安全（SMTP 侧是别的线程，API 侧是事件循环）。"""

    def __init__(self, domains: List[str], ttl_s: int = 3600, code_max_age_s: int = 900,
                 max_msgs: int = 50, max_boxes: int = 5000):
        self._lock = threading.RLock()
        self._boxes: Dict[str, Mailbox] = {}
        self._domains = list(domains) or ["localhost"]
        self._rr = 0
        self._ttl = ttl_s
        self._code_age = code_max_age_s
        self._max_msgs = max_msgs
        self._max_boxes = max_boxes
        self.started_at = time.time()
        self.acquired_total = 0
        self.received_total = 0

    # ---------- 地址 ----------
    def _pick_domain(self, want: Optional[str] = None) -> str:
        if want and want in self._domains:
            return want
        d = self._domains[self._rr % len(self._domains)]
        self._rr += 1
        return d

    def acquire(self, prefix: Optional[str] = None, domain: Optional[str] = None) -> dict:
        now = time.time()
        with self._lock:
            self._gc(now)
            if len(self._boxes) >= self._max_boxes:
                self._evict_oldest(len(self._boxes) - self._max_boxes + 1)
            dom = self._pick_domain(domain)
            pre = (prefix or "mb").strip().lower()
            pre = "".join(ch for ch in pre if ch.isalnum() or ch in "-_.") or "mb"
            for _ in range(8):
                rnd = "".join(random.choice(_ALPHABET) for _ in range(10))
                addr = pre + rnd + "@" + dom
                if addr not in self._boxes:
                    break
            else:
                raise RuntimeError("address space exhausted")
            box = Mailbox(address=addr, domain=dom, created_at=now, expires_at=now + self._ttl)
            self._boxes[addr] = box
            self.acquired_total += 1
            return {"address": addr, "domain": dom, "expires_at": box.expires_at}

    def acquire_batch(self, n: int, prefix: Optional[str] = None) -> List[dict]:
        n = max(1, min(int(n or 1), 500))
        return [self.acquire(prefix=prefix) for _ in range(n)]

    # ---------- 收信 ----------
    def deliver(self, rcpt: str, sender: str, subject: str, text: str) -> bool:
        rcpt = (rcpt or "").strip().lower()
        now = time.time()
        with self._lock:
            box = self._boxes.get(rcpt)
            if box is None:
                # catch-all 语义：地址没登记也收，方便"先发后领"
                dom = rcpt.split("@")[-1] if "@" in rcpt else "unknown"
                if dom not in self._domains:
                    return False
                box = Mailbox(address=rcpt, domain=dom, created_at=now, expires_at=now + self._ttl)
                self._boxes[rcpt] = box
            msg = MailMessage(ts=now, sender=sender, rcpt=rcpt, subject=subject or "",
                              text=text or "", codes=extract_codes(subject or "", text or ""))
            box.messages.append(msg)
            if len(box.messages) > self._max_msgs:
                box.messages = box.messages[-self._max_msgs:]
            self.received_total += 1
            return True

    # ---------- 取码 / 取信 ----------
    def latest_code(self, address: str, max_age_s: Optional[int] = None) -> Optional[str]:
        addr = (address or "").strip().lower()
        age = self._code_age if max_age_s is None else max_age_s
        now = time.time()
        with self._lock:
            box = self._boxes.get(addr)
            if not box:
                return None
            for m in reversed(box.messages):
                if now - m.ts > age:
                    continue
                if m.codes:
                    return m.codes[0]
        return None

    def messages(self, address: str, limit: int = 20) -> Optional[List[dict]]:
        addr = (address or "").strip().lower()
        with self._lock:
            box = self._boxes.get(addr)
            if not box:
                return None
            return [m.brief() for m in box.messages[-limit:]]

    def known(self, address: str) -> bool:
        with self._lock:
            return (address or "").strip().lower() in self._boxes

    # ---------- 统计 / 清理 ----------
    def stats(self) -> dict:
        with self._lock:
            self._gc(time.time())
            with_codes = sum(1 for b in self._boxes.values() if any(m.codes for m in b.messages))
            return {
                "service": "mailfarm",
                "version": "0.1.0",
                "store": "memory",
                "domains": self._domains,
                "mailboxes": len(self._boxes),
                "mailboxes_with_codes": with_codes,
                "messages": sum(len(b.messages) for b in self._boxes.values()),
                "acquired_total": self.acquired_total,
                "received_total": self.received_total,
                "uptime_s": round(time.time() - self.started_at, 1),
            }

    def healthz(self) -> dict:
        return {
            "ok": True,
            "version": "0.1.0",
            "store": "memory",
            "domains": self._domains,
            "uptime_s": round(time.time() - self.started_at, 1),
        }

    def _gc(self, now: float) -> None:
        dead = [a for a, b in self._boxes.items() if b.expires_at < now]
        for a in dead:
            self._boxes.pop(a, None)

    def _evict_oldest(self, k: int) -> None:
        for a, _ in sorted(self._boxes.items(), key=lambda kv: kv[1].created_at)[:k]:
            self._boxes.pop(a, None)
