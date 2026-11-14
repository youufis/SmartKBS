"""内容源（独立端口）：资源 HTML 在独立 origin 打开/嵌入，跨域天然隔离（替代 sandbox 的功能限制）。
Worker/importScripts/wasm 原生运行；/api/ 业务请求由桥改写回主源 + token。"""
from __future__ import annotations

import os
import threading

from fastapi import FastAPI

CONTENT_PORT = int(os.environ.get("SMARTKB_CONTENT_PORT", "8087"))


def create_content_app() -> FastAPI:
    from backend.api.files_router import router as files_router
    from backend.middleware import AuthMiddleware

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(AuthMiddleware)
    app.include_router(files_router, prefix="/api/files")
    return app


def start_content_server() -> None:
    import uvicorn

    app = create_content_app()
    config = uvicorn.Config(app, host="0.0.0.0", port=CONTENT_PORT, log_level="warning")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True, name="content-origin")
    t.start()
