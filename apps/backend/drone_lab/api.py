from pathlib import Path
import os

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .domain import CandidateDetails, ExperimentRequest, ExperimentRun, RunSummary, TestScenario, baseline_ir
from .storage import Store


def create_app(db_path=None):
    store = Store(db_path or os.getenv("DRONE_LAB_DB", "data/drone_lab.sqlite3"))
    app = FastAPI(title="翼构 · 无人机设计实验室", version="0.2.0")
    app.state.store = store

    @app.exception_handler(KeyError)
    async def not_found(request, exc):
        return JSONResponse(status_code=404, content={"detail": "实验不存在"})

    @app.get("/api/health")
    def health():
        return {"status": "ok", "stage": 2, "verification_level": "DYNAMICS", "version": "0.2.0"}

    @app.get("/api/defaults")
    def defaults():
        request = ExperimentRequest(evaluation_mode="dynamics", optimizer="evolution",
            scenario=TestScenario(scenario_id="wind-hover", duration_s=8, sim_dt_s=0.005))
        return {"request": request.model_dump(mode="json"),
                "baseline_ir": baseline_ir().model_dump(mode="json"),
                "capabilities": {"L1": "bounded-hover-allocation", "L2": "6dof-cascaded-pid", "L3": "not-implemented"}}

    @app.post("/api/experiments", status_code=201, response_model=ExperimentRun)
    def create(request: ExperimentRequest):
        return store.create(request)

    @app.get("/api/experiments", response_model=list[RunSummary])
    def list_runs():
        return store.list_runs()

    @app.get("/api/experiments/{run_id}", response_model=ExperimentRun)
    def detail(run_id: str):
        return store.detail(run_id)

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

    web = Path(__file__).resolve().parents[2] / "web" / "dist"
    if web.exists():
        app.mount("/assets", StaticFiles(directory=web/"assets"), name="assets")

        @app.get("/", include_in_schema=False)
        def index():
            return FileResponse(web/"index.html")

    return app


app = create_app()
