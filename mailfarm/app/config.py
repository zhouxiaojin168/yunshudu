"""mailfarm 配置：全部走环境变量，零硬编码密钥。"""
import os


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    v = _env(name)
    try:
        return int(v) if v else default
    except ValueError:
        return default


class Settings:
    # --- 身份 ---
    service_name = _env("MF_SERVICE_NAME", "mailfarm")
    version = "0.1.0"

    # --- 收信域（逗号分隔）；acquire 会从这里挑 ---
    domains = [d for d in _env("MF_DOMAINS", "localhost").split(",") if d]

    # --- 鉴权：/v1/stats 必带；acquire 是否强制 ---
    api_key = _env("MF_API_KEY")
    require_key_on_acquire = _env("MF_REQUIRE_KEY_ON_ACQUIRE", "0") in ("1", "true", "yes")

    # --- 网络 ---
    http_host = _env("MF_HTTP_HOST", "127.0.0.1")
    http_port = _env_int("MF_HTTP_PORT", 8099)
    smtp_host = _env("MF_SMTP_HOST", "0.0.0.0")
    smtp_port = _env_int("MF_SMTP_PORT", 25)
    # 本地自测可改成 10025 之类，避免占用 25
    smtp_ident = _env("MF_SMTP_IDENT", "mailfarm")
    smtp_max_size = _env_int("MF_SMTP_MAX_SIZE", 33554432)  # 对齐实测 32MB

    # --- 生命周期 ---
    mailbox_ttl_s = _env_int("MF_MAILBOX_TTL_S", 3600)      # 地址保留时长
    code_max_age_s = _env_int("MF_CODE_MAX_AGE_S", 900)     # 验证码有效期
    max_messages_per_box = _env_int("MF_MAX_MSGS_PER_BOX", 50)
    max_boxes = _env_int("MF_MAX_BOXES", 5000)


settings = Settings()
