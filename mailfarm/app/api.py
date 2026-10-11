"""mailfarm HTTP API：对齐实测端点与响应形状。

GET  /healthz                                 公开，返回 domains 清单
POST /v1/mailboxes/acquire                    {prefix?, domain?}
POST /v1/mailboxes/acquire_batch              {n=10, prefix?}
GET  /v1/mailboxes/{address}/code?timeout=0..120
GET  /v1/mailboxes/{address}/messages?limit=1..200
GET  /v1/stats                                需 x-api-key
"""
import asyncio
import time

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from .config import settings
from .store import MailStore

store = MailStore(
    domains=settings.domains,
    ttl_s=settings.mailbox_ttl_s,
    code_max_age_s=settings.code_max_age_s,
    max_msgs=settings.max_messages_per_box,
    max_boxes=settings.max_boxes,
)

app = FastAPI(title=settings.service_name, version=settings.version)


# ---------------- 鉴权 ----------------
def need_key(x_api_key: str = Header(default=None)) -> None:
    """没配 MF_API_KEY 时视为开发模式放行；配了就严格校验。"""
    if not settings.api_key:
        return
    if not x_api_key or x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="bad api key")


def maybe_key_on_acquire(x_api_key: str = Header(default=None)) -> None:
    if settings.require_key_on_acquire:
        need_key(x_api_key)


# ---------------- 模型 ----------------
class AcquireBody(BaseModel):
    prefix: str | None = None
    domain: str | None = None


class AcquireBatchBody(BaseModel):
    n: int = 10
    prefix: str | None = None


# ---------------- 路由 ----------------
@app.get("/healthz")
async def healthz():
    return store.healthz()


@app.post("/v1/mailboxes/acquire", dependencies=[Depends(maybe_key_on_acquire)])
async def acquire(body: AcquireBody | None = None):
    b = body or AcquireBody()
    return store.acquire(prefix=b.prefix, domain=b.domain)


@app.post("/v1/mailboxes/acquire_batch", dependencies=[Depends(maybe_key_on_acquire)])
async def acquire_batch(body: AcquireBatchBody):
    boxes = store.acquire_batch(n=body.n, prefix=body.prefix)
    return {"count": len(boxes), "mailboxes": boxes}


@app.get("/v1/mailboxes/{address}/code")
async def get_code(address: str,
                   timeout: float = Query(default=0, ge=0, le=120),
                   x_api_key: str = Header(default=None)):
    """timeout>0 时长轮询；取到码立刻返回。"""
    if settings.api_key and x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="bad api key")
    deadline = time.time() + timeout
    while True:
        code = store.latest_code(address)
        if code:
            return {"address": address, "code": code, "found": True}
        if time.time() >= deadline:
            return {"address": address, "code": None, "found": False}
        await asyncio.sleep(0.25)


@app.get("/v1/mailboxes/{address}/messages")
async def get_messages(address: str,
                       limit: int = Query(default=20, ge=1, le=200),
                       x_api_key: str = Header(default=None)):
    if settings.api_key and x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="bad api key")
    msgs = store.messages(address, limit=limit)
    if msgs is None:
        raise HTTPException(status_code=404, detail="mailbox not found")
    return {"address": address, "count": len(msgs), "messages": msgs}


@app.get("/v1/stats", dependencies=[Depends(need_key)])
async def stats():
    return store.stats()


@app.get("/", response_class=HTMLResponse)
async def index():
    s = store.stats()
    doms = " , ".join(s["domains"])
    return (
        "<html><head><title>" + settings.service_name + "</title></head><body>"
        "<h3>" + settings.service_name + " " + settings.version + "</h3>"
        "<p>domains: " + doms + "</p>"
        "<p>mailboxes: " + str(s["mailboxes"]) + " | messages: " + str(s["messages"]) + "</p>"
        "<p><a href=\"/docs\">/docs</a> - <a href=\"/openapi.json\">/openapi.json</a></p>"
        "</body></html>"
    )
