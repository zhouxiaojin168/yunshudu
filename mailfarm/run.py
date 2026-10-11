"""单进程同时跑 SMTP(收信) + HTTP(发号/取码)。"""
import logging
import sys

import uvicorn

from app.api import app, store
from app.config import settings
from app.smtp import make_controller

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
log = logging.getLogger("mailfarm")


def main() -> int:
    if not settings.domains or settings.domains == ["localhost"]:
        log.warning("MF_DOMAINS 未设置，当前收信域 = %s", settings.domains)

    controller = make_controller(store)
    try:
        controller.start()
    except OSError as exc:
        log.error("SMTP 绑定失败 %s:%s -> %s", settings.smtp_host, settings.smtp_port, exc)
        log.error("提示：本地自测可用 MF_SMTP_PORT=10025；生产需 25 端口可用")
        return 2

    log.info("SMTP listening on %s:%s (ident=%s)", settings.smtp_host,
             settings.smtp_port, settings.smtp_ident)
    log.info("HTTP listening on http://%s:%s  (docs=/docs)", settings.http_host,
             settings.http_port)
    log.info("domains = %s", ",".join(settings.domains))
    log.info("api_key %s", "已启用" if settings.api_key else "未设置(开发模式)")

    try:
        uvicorn.run(app, host=settings.http_host, port=settings.http_port, log_level="info")
    finally:
        controller.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
