import asyncio
from pathlib import Path
import os
import time
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .core_adapter import check_l1
from .domain import (
    CachePruneRequest, CachePruneResult, CandidateDetails, CandidateRecord, EvalResult,
    ExperimentRequest, ExperimentRun, HealthStatus, L1CheckRequest, PresetSpec, RenameRunRequest,
    RevisionRequest, RunStatus, RunSummary, TestScenario, baseline_ir,
)
from .presets import PRESETS
from .storage import Store, dump

SSE_POLL_SEC = 0.5
SSE_PING_SEC = 15
SSE_BATCH_SIZE = 100
SQLITE_MAX_INT = 2**63 - 1


def _sse(kind, payload, seq=None):
    cursor = f"id: {seq}\n" if seq is not None else ""
    return f"{cursor}event: {kind}\ndata: {dump(payload)}\n\n"


async def _stream_run(store, run_id, after_seq, initial):
    snapshot = initial
    previous = None
    last_send = time.monotonic()
    while True:
        summary, events, done = snapshot
        # The running clock advances on every read without a stored state change.
        version = {key: value for key, value in summary.items() if key != "elapsed_sec"}
        changed = version != previous
        if changed:
            yield _sse("update", summary)
            previous = version
        for event in events:
            after_seq = event["seq"]
            yield _sse("event", event, after_seq)
        if done and len(events) < SSE_BATCH_SIZE:
            yield _sse("done", summary)
            return
        if changed or events:
            last_send = time.monotonic()
        elif time.monotonic() - last_send >= SSE_PING_SEC:
            yield ": ping\n\n"
            last_send = time.monotonic()
        if len(events) < SSE_BATCH_SIZE:
            await asyncio.sleep(SSE_POLL_SEC)
        try:
            snapshot = await run_in_threadpool(store.stream_snapshot, run_id, after_seq, SSE_BATCH_SIZE)
        except KeyError:
            yield _sse("done", None)
            return


def create_app(db_path=None):
    store = Store(db_path or os.getenv("DRONE_LAB_DB", "data/drone_lab.sqlite3"))
    app = FastAPI(title="翼构 · 无人机设计实验室", version="0.3.0")
    app.state.store = store

    @app.exception_handler(KeyError)
    async def not_found(request, exc):
        return JSONResponse(status_code=404, content={"detail": "实验不存在"})

    @app.get("/api/health", response_model=HealthStatus)
    def health():
        heartbeat = store.latest_heartbeat()
        alive = heartbeat is not None and time.time() - heartbeat["updated_at"] <= 10
        return HealthStatus(
            worker_alive=alive,
            worker_status=heartbeat["status"] if heartbeat is not None else None,
            worker_last_heartbeat=heartbeat["updated_at"] if heartbeat is not None else None,
            active_run_id=heartbeat["current_run_id"] if alive else None,
            active_candidate_id=heartbeat["current_candidate_id"] if alive else None,
        )

    @app.get("/api/defaults")
    def defaults():
        request = ExperimentRequest(evaluation_mode="dynamics", optimizer="evolution",
            scenario=TestScenario(scenario_id="wind-hover", duration_s=8, sim_dt_s=0.005))
        return {"request": request.model_dump(mode="json"),
                "baseline_ir": baseline_ir().model_dump(mode="json"),
                "capabilities": {"L1": "bounded-hover-allocation", "L2": "6dof-cascaded-pid", "L3": "not-implemented"}}

    @app.get("/api/presets", response_model=list[PresetSpec])
    def list_presets():
        return PRESETS

    @app.post("/api/cache/prune", response_model=CachePruneResult)
    def prune_cache(request: CachePruneRequest):
        return store.prune_cache_with_count(request.max_entries, request.max_age_days)

    @app.post("/api/evaluate/l1", response_model=EvalResult)
    def evaluate_l1(request: L1CheckRequest):
        return check_l1(request)

    @app.post("/api/experiments", status_code=201, response_model=ExperimentRun)
    def create(request: ExperimentRequest):
        return store.create(request)

    @app.get("/api/experiments", response_model=list[RunSummary])
    def list_runs(limit: int = Query(50, ge=1, le=SQLITE_MAX_INT),
                  offset: int = Query(0, ge=0, le=SQLITE_MAX_INT), status: RunStatus | Literal[""] | None = None):
        return store.list_runs(limit, offset, status or None)

    @app.get("/api/experiments/{run_id}", response_model=ExperimentRun)
    def detail(run_id: str):
        return store.detail(run_id)

    @app.patch("/api/experiments/{run_id}", response_model=RunSummary)
    def rename(run_id: str, request: RenameRunRequest):
        return store.rename_run(run_id, request.name)

    @app.delete("/api/experiments/{run_id}", status_code=204, response_class=Response)
    def delete(run_id: str, force: bool = False):
        try:
            deleted = store.delete_run(run_id, force=force)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        if not deleted:
            raise KeyError(run_id)
        return Response(status_code=204)

    @app.get("/api/experiments/{run_id}/stream", response_class=StreamingResponse,
             responses={200: {"content": {"text/event-stream": {}}}})
    async def stream(run_id: str, request: Request, after_seq: int = Query(0, ge=0, le=SQLITE_MAX_INT)):
        # EventSource sends its last acknowledged event on an automatic reconnect.
        try:
            last_seq = int(request.headers.get("last-event-id", "0"))
        except ValueError:
            last_seq = 0
        if after_seq < last_seq <= SQLITE_MAX_INT:
            after_seq = last_seq
        initial = await run_in_threadpool(store.stream_snapshot, run_id, after_seq, SSE_BATCH_SIZE)
        return StreamingResponse(
            _stream_run(store, run_id, after_seq, initial), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/experiments/{run_id}/{action}", response_model=ExperimentRun)
    def control(run_id: str, action: str):
        if action == "retry":
            return store.retry(run_id)
        if action not in {"pause", "resume", "cancel"}:
            raise HTTPException(404, "操作不存在")
        try:
            return store.transition(run_id, action)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/experiments/{run_id}/report")
    def report(run_id: str):
        return JSONResponse(store.report(run_id), headers={"Content-Disposition": f'attachment; filename="experiment-{run_id}.json"'})

    @app.get("/api/experiments/{run_id}/candidates/{candidate_id}/ir")
    def export_ir(run_id: str, candidate_id: str):
        candidate = next((c for c in store.detail(run_id)["candidates"] if c["candidate_id"] == candidate_id), None)
        if candidate is None:
            raise HTTPException(404, "候选方案不存在")
        return JSONResponse({"ir_hash": candidate["ir_hash"], "drone_ir": candidate["ir"]},
            headers={"Content-Disposition": f'attachment; filename="drone-{candidate["ir_hash"][:12]}.json"'})

    @app.get("/api/experiments/{run_id}/candidates/{candidate_id}", response_model=CandidateDetails)
    def candidate_details(run_id: str, candidate_id: str):
        return store.candidate_details(run_id, candidate_id)

    @app.post("/api/experiments/{run_id}/candidates/evaluate", response_model=CandidateRecord, status_code=202)
    def evaluate_revision(run_id: str, revision: RevisionRequest):
        try:
            return store.enqueue_revision(run_id, revision)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    web = Path(__file__).resolve().parents[2] / "web" / "dist"
    if web.exists():
        app.mount("/assets", StaticFiles(directory=web/"assets"), name="assets")

        @app.get("/", include_in_schema=False)
        def index():
            return FileResponse(web/"index.html")

    return app


app = create_app()
