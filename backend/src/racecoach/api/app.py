"""The FastAPI app: routes under /api, the folder watcher, and the built frontend."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from racecoach.api import errors
from racecoach.api.errors import ApiError
from racecoach.api.routes import router
from racecoach.settings import Settings
from racecoach.store import AppStore
from racecoach.watcher import watch_forever

log = logging.getLogger(__name__)
FRONTEND_DIST = Path(__file__).resolve().parents[4] / "frontend" / "dist"


def create_app(
    settings: Settings | None = None, store: AppStore | None = None,
    frontend_dist: Path | None = FRONTEND_DIST, watch: bool = True,
) -> FastAPI:  # fmt: skip
    settings = settings or Settings()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        own = store is None
        app.state.store = store or AppStore(settings.db_path, settings.traces_dir)
        task: asyncio.Task[None] | None = None
        watch_store: AppStore | None = None
        tdir = settings.lmu_telemetry_dir
        if watch and tdir is not None and Path(tdir).is_dir():
            # the watcher scans in a worker thread: it gets its own cursor
            watch_store = app.state.store.view()
            task = asyncio.create_task(
                watch_forever(
                    watch_store, tdir, settings.raw_dir, settings.watch_settle_s,
                    settings.watch_poll_s,
                )
            )  # fmt: skip
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            if own:
                app.state.store.close()

    app = FastAPI(title="racecoach", lifespan=lifespan)
    app.state.settings = settings
    if store is not None:
        app.state.store = store
    errors.install(app)
    app.include_router(router)

    if frontend_dist is not None and (frontend_dist / "index.html").is_file():
        dist = frontend_dist
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            if path == "api" or path.startswith("api/"):
                raise ApiError("not_found", f"No route /{path}.", 404)
            f = (dist / path).resolve()
            if path and f.is_file() and dist.resolve() in f.parents:
                return FileResponse(f)
            return FileResponse(dist / "index.html")

    return app
