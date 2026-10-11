"""验证码提取：关键字锚定优先，其次通用数字/字母数字。"""
import re
from typing import List, Optional

# 关键字锚定（中英日韩常见写法）
KW = (r"(?:验证码|校验码|动态码|确认码|安全码|verification\s*code|verify\s*code"
      r"|login\s*code|security\s*code|one[\s-]?time\s*(?:code|password)|otp"
      r"|認証コード|인증\s*번호)")

_KW_DIGIT = re.compile(KW + r"[^0-9]{0,24}([0-9]{4,8})", re.I)
_KW_ALNUM = re.compile(KW + r"[^A-Za-z0-9]{0,24}([A-Za-z0-9]{4,8})", re.I)
_ANY_DIGIT = re.compile(r"(?<![0-9])([0-9]{4,8})(?![0-9])")
_ANY_ALNUM = re.compile(r"(?<![A-Za-z0-9])([A-Z0-9]{5,8})(?![A-Za-z0-9])")


def _is_code(tok: str, allow_alpha_only: bool = False) -> bool:
    """必须像码：4~8 位；含数字，或（低优先级）全大写纯字母 >=5 位。"""
    if not (4 <= len(tok) <= 8):
        return False
    if any(ch.isdigit() for ch in tok):
        return True
    if allow_alpha_only and tok.isupper() and len(tok) >= 5 and tok.isalnum():
        return True
    return False


def extract_codes(subject: Optional[str], text: Optional[str], limit: int = 5) -> List[str]:
    """按优先级返回候选码；**主题与正文分开扫**，避免跨边界误抓（如 subject=Login code / body=Your ...）。"""
    out: List[str] = []

    def push(val: str, allow_alpha_only: bool = False) -> None:
        v = (val or "").strip()
        if _is_code(v, allow_alpha_only=allow_alpha_only) and v not in out:
            out.append(v)

    blobs = [b for b in ((subject or ""), (text or "")) if b]

    for blob in blobs:
        for m in _KW_DIGIT.finditer(blob):
            push(m.group(1))
            if len(out) >= limit:
                return out
    for blob in blobs:
        for m in _KW_ALNUM.finditer(blob):
            push(m.group(1))
            if len(out) >= limit:
                return out
    for blob in blobs:
        for m in _ANY_DIGIT.finditer(blob):
            push(m.group(1))
            if len(out) >= limit:
                return out
    for blob in blobs:
        for m in _ANY_ALNUM.finditer(blob):
            push(m.group(1), allow_alpha_only=True)
            if len(out) >= limit:
                return out
    return out
