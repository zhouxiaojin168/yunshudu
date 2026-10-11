"""收信侧：aiosmtpd，banner 用服务名（对齐实测 220 mailfarm mailfarm）。"""
import asyncio
import email
import email.policy
import logging
from email.message import Message
from typing import Optional

from aiosmtpd.controller import Controller
from aiosmtpd.smtp import SMTP as SMTPServer, Envelope

from .config import settings

log = logging.getLogger("mailfarm.smtp")


def _text_of(msg: Message) -> str:
    """尽量抽出纯文本正文；没有 text/plain 就退回 HTML 去标签。"""
    try:
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    payload = part.get_payload(decode=True) or b""
                    return payload.decode(part.get_content_charset() or "utf-8", "replace")
            for part in msg.walk():
                if part.get_content_type() == "text/html":
                    payload = part.get_payload(decode=True) or b""
                    html = payload.decode(part.get_content_charset() or "utf-8", "replace")
                    return _strip_tags(html)
            return ""
        payload = msg.get_payload(decode=True) or b""
        text = payload.decode(msg.get_content_charset() or "utf-8", "replace")
        if msg.get_content_type() == "text/html":
            return _strip_tags(text)
        return text
    except Exception as exc:  # pragma: no cover
        log.warning("body parse failed: %s", exc)
        return ""


def _strip_tags(html: str) -> str:
    out, depth = [], 0
    for ch in html:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth = max(0, depth - 1)
            out.append(" ")
        elif depth == 0:
            out.append(ch)
    return "".join(out)


class Handler:
    def __init__(self, store):
        self.store = store

    async def handle_DATA(self, server, session, envelope: Envelope):
        msg = email.message_from_bytes(envelope.content, policy=email.policy.default)
        subject = str(msg.get("Subject") or "")
        body = _text_of(msg)
        sender = envelope.mail_from or ""
        ok = 0
        for rcpt in envelope.rcpt_tos:
            if self.store.deliver(rcpt=rcpt, sender=sender, subject=subject, text=body):
                ok += 1
        log.info("recv from=%s rcpt=%s ok=%d subject=%r", sender, envelope.rcpt_tos, ok, subject[:60])
        return "250 Message accepted for delivery"


class _FarmSMTP(SMTPServer):
    """让 banner 与 EHLO 都报服务名（对齐实测 220 mailfarm mailfarm）。"""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("hostname", settings.smtp_ident)
        kwargs.setdefault("ident", settings.smtp_ident)
        super().__init__(*args, **kwargs)


class _FarmController(Controller):
    """1.4.x 的 Controller 不接受 server_class，只能重写 factory()。"""

    def factory(self):
        return _FarmSMTP(self.handler, **self.SMTP_kwargs)


def make_controller(store) -> Controller:
    return _FarmController(
        Handler(store),
        hostname=settings.smtp_host,
        port=settings.smtp_port,
        data_size_limit=settings.smtp_max_size,
        enable_SMTPUTF8=True,
    )
