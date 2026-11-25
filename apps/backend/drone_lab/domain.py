"""Versioned contracts. SI units, body FRD and world NED throughout."""
from __future__ import annotations

import hashlib
import json
import math
from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Positive = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Nonnegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Vector3 = tuple[float, float, float]
Metric = Literal["total_mass_kg", "thrust_to_weight_ratio", "flight_time_min", "tracking_rmse_m", "hover_power_w",
                 "max_tilt_deg", "crash_rate", "saturation_frac", "flight_time_min_sim", "max_pos_err_m", "final_pos_err_m"]
SEARCH_PATHS = {"power.capacity_wh", "rotors[*].max_thrust_n", "airframe.base_mass_kg",
                "rotors[*].arm_length_m", "rotors[*].prop_radius_m", "rotors[*].motor_time_constant_s"}


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, json_schema_serialization_defaults_required=True)


def content_hash(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class Airframe(Model):
    topology: Literal["multirotor"] = "multirotor"
    base_mass_kg: Positive = 0.55
    inertia_diag_kg_m2: tuple[Positive, Positive, Positive] = (0.02, 0.02, 0.04)
    cg_offset_m: Vector3 = (0, 0, 0)
    linear_drag_coeff: Vector3 = (0.1, 0.1, 0.15)


class Rotor(Model):
    id: str
    position_m: Vector3
    thrust_axis: Vector3 = (0, 0, -1)
    spin_direction: Literal[-1, 1]
    max_thrust_n: Positive = 8.0
    torque_to_thrust_ratio: Positive = 0.02
    motor_time_constant_s: Positive = 0.03
    prop_radius_m: Positive = 0.1

    @model_validator(mode="after")
    def unit_axis(self):
        if not math.isclose(sum(x*x for x in self.thrust_axis), 1, abs_tol=1e-6):
            raise ValueError("thrust_axis 必须是单位向量")
        return self


class Power(Model):
    battery_mass_kg: Positive = 0.4
    capacity_wh: Positive = 72
    max_discharge_w: Positive = 800


class Payload(Model):
    mass_kg: Nonnegative = 0.2
    position_m: Vector3 = (0, 0, 0)


class Controller(Model):
    type: Literal["cascaded_pid", "lqr"] = "cascaded_pid"
    auto_scale_gains: bool = True
    params: dict[str, float] = Field(default_factory=dict)


class DroneIR(Model):
    schema_version: Literal["1.0.0"] = "1.0.0"
    airframe: Airframe = Field(default_factory=Airframe)
    rotors: list[Rotor] = Field(min_length=4, max_length=8)
    power: Power = Field(default_factory=Power)
    payload: Payload = Field(default_factory=Payload)
    controller: Controller = Field(default_factory=Controller)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({r.id for r in self.rotors}) != len(self.rotors):
            raise ValueError("旋翼 ID 不可重复")
        return self

    @property
    def ir_hash(self) -> str:
        return content_hash(self.model_dump(mode="json"))


class SearchParameter(Model):
    param_path: str
    type: Literal["continuous"] = "continuous"
    bounds: tuple[Positive, Positive]

    @model_validator(mode="after")
    def supported(self):
        if self.param_path not in SEARCH_PATHS:
            raise ValueError(f"支持的搜索参数：{sorted(SEARCH_PATHS)}")
        if self.bounds[0] > self.bounds[1]:
            raise ValueError("搜索下界不可大于上界")
        return self


class Constraint(Model):
    metric: Metric
    operator: Literal["<=", ">=", "=="]
    limit: float


class Objective(Model):
    metric: Metric
    direction: Literal["maximize", "minimize"]
    weight: Positive = 1


class Budget(Model):
    max_generations: int = Field(default=10, ge=1, le=10000)
    batch_size: int = Field(default=8, ge=1, le=100)
    max_l1_evals: int = Field(default=100, ge=1, le=100000)
    max_l2_evals: int = Field(default=80, ge=0, le=100000)
    max_l3_evals: Literal[0] = 0
    timeout_sec: int = Field(default=300, ge=1, le=86400)


class DesignGoal(Model):
    name: str = Field(default="续航与稳定性探索", min_length=1, max_length=100)
    search_space: list[SearchParameter] = Field(default_factory=lambda: [
        SearchParameter(param_path="power.capacity_wh", bounds=(35, 130)),
        SearchParameter(param_path="rotors[*].max_thrust_n", bounds=(3, 12)),
    ], max_length=6)
    constraints: list[Constraint] = Field(default_factory=lambda: [
        Constraint(metric="total_mass_kg", operator="<=", limit=1.5),
        Constraint(metric="thrust_to_weight_ratio", operator=">=", limit=2),
    ], max_length=20)
    objectives: list[Objective] = Field(default_factory=lambda: [
        Objective(metric="flight_time_min", direction="maximize"),
        Objective(metric="tracking_rmse_m", direction="minimize"),
    ], min_length=1, max_length=5)
    budget: Budget = Field(default_factory=Budget)

    @model_validator(mode="after")
    def unique_paths(self):
        if len({p.param_path for p in self.search_space}) != len(self.search_space):
            raise ValueError("搜索参数不可重复")
        if len({o.metric for o in self.objectives}) != len(self.objectives):
            raise ValueError("优化目标不可重复")
        return self


class Waypoint(Model):
    t_s: Nonnegative
    position_m: Vector3


class Mission(Model):
    type: Literal["hover", "step_response", "waypoints"] = "hover"
    altitude_m: Positive = 5
    step_m: Vector3 = (1, 0, 0)
    step_time_s: Nonnegative = 1
    waypoints: list[Waypoint] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def valid_waypoints(self):
        if self.type == "waypoints" and not self.waypoints:
            raise ValueError("航点场景必须提供航点")
        return self


class FaultInjection(Model):
    trigger_time_s: Nonnegative
    target_rotor_id: str
    fault_type: Literal["motor_out", "thrust_loss"]
    severity: float = Field(gt=0, le=1)


class DomainRandomization(Model):
    enabled: bool = False
    trials: int = Field(default=2, ge=1, le=20)
    mass_variance_pct: float = Field(default=10, ge=0, le=50)
    thrust_variance_pct: float = Field(default=0.0, ge=0, lt=100, allow_inf_nan=False)
    cg_offset_variance_m: Nonnegative = 0.0


class TestScenario(Model):
    scenario_id: str = Field(default="hover-demo", min_length=1, max_length=100)
    version: str = "1.0.0"
    duration_s: Positive = 30
    sim_dt_s: Positive = 0.02
    air_density_kg_m3: Positive = 1.225
    wind_velocity_m_s: Vector3 = (1, 0, 0)
    wind_type: Literal["none", "constant", "gust"] = "constant"
    gust_start_s: Nonnegative = 2.0
    gust_duration_s: Positive = 4.0
    mission: Mission = Field(default_factory=Mission)
    fault_injections: list[FaultInjection] = Field(default_factory=list, max_length=20)
    domain_randomization: DomainRandomization = Field(default_factory=DomainRandomization)

    @model_validator(mode="after")
    def bounded(self):
        if self.duration_s > 600 or self.sim_dt_s > self.duration_s:
            raise ValueError("场景时长须 ≤600 秒，步长须 ≤场景时长")
        if self.duration_s / self.sim_dt_s > 200000:
            raise ValueError("单场景积分步数不可超过 200000")
        if any(f.trigger_time_s >= self.duration_s for f in self.fault_injections):
            raise ValueError("故障触发时间须小于场景时长")
        if any(w.t_s > self.duration_s for w in self.mission.waypoints):
            raise ValueError("航点时间不可超过场景时长")
        return self


class ExperimentRequest(Model):
    goal: DesignGoal = Field(default_factory=DesignGoal)
    scenario: TestScenario = Field(default_factory=TestScenario)
    seed: int = Field(default=42, ge=0, le=2147483647)
    seed_ir: DroneIR | None = None
    # Legacy snapshots without these fields must retain their old interpretation.
    evaluation_mode: Literal["demo", "dynamics"] = "demo"
    optimizer: Literal["random", "evolution", "nsga2"] = "random"
    start_paused: bool = False

    @model_validator(mode="after")
    def supported_simulation(self):
        ir = self.seed_ir or baseline_ir()
        if any(f.target_rotor_id not in {r.id for r in ir.rotors} for f in self.scenario.fault_injections):
            raise ValueError("故障目标旋翼不存在于种子构型")
        if self.evaluation_mode == "dynamics":
            min_tau = min(r.motor_time_constant_s for r in ir.rotors)
            for p in self.goal.search_space:
                if p.param_path == "rotors[*].motor_time_constant_s":
                    min_tau = min(min_tau, p.bounds[0])
            if self.scenario.sim_dt_s > min(0.01, min_tau/2):
                raise ValueError("动力学步长须 ≤0.01 秒且 ≤最小电机时间常数的一半")
            if any(r.thrust_axis != (0, 0, -1) for r in ir.rotors):
                raise ValueError("当前动力学控制器仅支持竖直推力旋翼")
            gain_names = {"rate_kr", "rate_kp", "att_kp", "pos_kp", "pos_kd", "pos_ki"} if ir.controller.type == "cascaded_pid" else set()
            if set(ir.controller.params) - gain_names:
                raise ValueError("控制器包含当前动力学模型不支持的增益参数")
        return self


class PresetSpec(Model):
    id: str
    title: str
    summary: str
    difficulty: Literal["starter", "intermediate", "advanced"]
    estimated_sec: int = Field(gt=0)
    request: ExperimentRequest


class L1CheckRequest(Model):
    drone_ir: DroneIR
    goal: DesignGoal
    scenario: TestScenario


class RenameRunRequest(Model):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class CachePruneRequest(Model):
    max_entries: int = Field(default=2000, ge=0, le=2**63 - 1)
    max_age_days: Nonnegative | None = None


class CachePruneResult(Model):
    deleted: int
    remaining: int


class HealthStatus(Model):
    status: Literal["ok"] = "ok"
    stage: int = 2
    verification_level: Literal["DYNAMICS"] = "DYNAMICS"
    version: str = "0.3.0"
    worker_alive: bool
    worker_status: Literal["idle", "busy"] | None
    worker_last_heartbeat: float | None
    active_run_id: str | None
    active_candidate_id: str | None


class Violation(Model):
    rule: str
    actual: float
    limit: float
    message: str = ""


class ReplayData(Model):
    coordinate_frame: Literal["NED"] = "NED"
    quaternion_order: Literal["wxyz"] = "wxyz"
    frames: list[tuple[float, float, float, float, float, float, float, float]]


class EvalResult(Model):
    evaluator_level: Literal["L1", "L2", "L3"]
    evaluator_version: str
    status: Literal["PASSED", "REJECTED_CONSTRAINT", "CRASHED", "TIMEOUT", "UNSUPPORTED"]
    metrics: dict[str, float] = Field(default_factory=dict)
    violations: list[Violation] = Field(default_factory=list)
    execution_time_ms: Nonnegative = 0
    fidelity: Literal["ANALYTIC", "DEMO", "DYNAMICS"]
    message: str = ""
    replay: ReplayData | None = None
    resolved_parameters: dict[str, float] = Field(default_factory=dict)
    fitness_score: float | None = None


class CandidateRecord(Model):
    candidate_id: str
    run_id: str
    proposal_index: int
    generation: int
    ir_hash: str
    ir: DroneIR
    status: Literal["NEW", "L1_PASSED", "PASSED", "REJECTED_CONSTRAINT", "CRASHED", "TIMEOUT", "UNSUPPORTED", "SKIPPED"]
    metrics: dict[str, float]
    violations: list[Violation]
    source: Literal["optimizer", "manual_revision"] = "optimizer"
    parent_ir_hash: str | None = None


class RevisionRequest(Model):
    parent_ir_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    drone_ir: DroneIR


class RunEvent(Model):
    seq: int
    run_id: str
    created_at: float
    kind: str
    message: str


RunStatus = Literal["QUEUED", "RUNNING", "PAUSED", "CANCELLED", "COMPLETED"]


class RunSummary(Model):
    id: str
    name: str
    status: RunStatus
    created_at: float
    updated_at: float
    elapsed_sec: Nonnegative
    seed: int
    next_index: int
    l1_used: int
    l2_used: int
    cache_hits: int
    stop_reason: str | None
    budget: Budget


class ExperimentRun(RunSummary):
    request: ExperimentRequest
    candidates: list[CandidateRecord]
    pareto_ids: list[str]
    passed: int
    rejected: int
    events: list[RunEvent]


class EvaluationRecord(Model):
    id: str
    candidate_id: str
    level: str
    cache_key: str
    result: EvalResult
    cache_hit: bool


class AttemptRecord(Model):
    id: str
    run_id: str
    candidate_id: str
    level: str
    status: str
    started_at: float
    finished_at: float | None
    error: str | None


class CandidateDetails(Model):
    candidate: CandidateRecord
    request: ExperimentRequest
    evaluations: list[EvaluationRecord]
    attempts: list[AttemptRecord]


class IOptimizer(Protocol):
    def suggest(self, request: ExperimentRequest, index: int) -> DroneIR: ...
    def observe(self, results: list[EvalResult]) -> None: ...


class IEvaluator(Protocol):
    level: str
    version: str
    def evaluate(self, ir: DroneIR, scenario: TestScenario, seed: int) -> EvalResult: ...


class ICompiler(Protocol):
    target: str
    def compile(self, ir: DroneIR) -> dict[str, str | bytes]: ...


def baseline_ir() -> DroneIR:
    return DroneIR(rotors=[Rotor(id=f"r{i+1}", position_m=p, spin_direction=s)
        for i, (p, s) in enumerate([
            ((0.18, 0.18, 0), 1), ((-0.18, 0.18, 0), -1),
            ((-0.18, -0.18, 0), 1), ((0.18, -0.18, 0), -1),
        ])])
