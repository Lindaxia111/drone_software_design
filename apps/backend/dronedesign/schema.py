"""核心数据契约（对应架构文档第二章的五大实体）。

铁律落地：
  1. 全链路 SI 单位 + FRD 坐标系（前-右-下，常规朝上推力轴为 [0, 0, -1]）。
  2. ir_hash = 规范化 JSON 的 SHA-256（内容寻址，物理等价方案命中同一缓存）。
  3. 搜索空间与 IR 解耦：DroneIR 只描述确定的飞机，上下界仅存在于 DesignGoal。
  4. schema_version 参与哈希与缓存键，升级后旧缓存自动失效。
"""
from __future__ import annotations

import hashlib
import json
import math
import uuid
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0.0"

Num = Annotated[float, Field(allow_inf_nan=False)]
Vec3 = tuple[Num, Num, Num]


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


# --------------------------------------------------------------------------
# 规范化与哈希
# --------------------------------------------------------------------------
def _canon(x: Any) -> Any:
    """浮点保留 9 位有效数字，消除 -0.0 与浮点噪声；dict 排序。"""
    if isinstance(x, bool):
        return x
    if isinstance(x, float):
        if not math.isfinite(x):
            raise ValueError("non-finite number in canonical form")
        r = float(f"{x:.9g}")
        return 0.0 if r == 0 else r
    if isinstance(x, dict):
        return {k: _canon(v) for k, v in sorted(x.items())}
    if isinstance(x, (list, tuple)):
        return [_canon(v) for v in x]
    return x


def _sha256_json(obj: Any) -> str:
    s = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# (2) DroneIR —— 平台核心 AST
# --------------------------------------------------------------------------
class Airframe(_Frozen):
    topology: str = "multirotor"
    base_mass_kg: float = Field(gt=0, allow_inf_nan=False)
    inertia_diag_kg_m2: tuple[
        Annotated[float, Field(gt=0, allow_inf_nan=False)],
        Annotated[float, Field(gt=0, allow_inf_nan=False)],
        Annotated[float, Field(gt=0, allow_inf_nan=False)],
    ]
    cg_offset_m: Vec3 = (0.0, 0.0, 0.0)
    linear_drag_coeff: Vec3 = (0.0, 0.0, 0.0)  # N/(m/s)，机体系三轴


class Rotor(_Frozen):
    id: str
    position_m: Vec3
    thrust_axis: Vec3 = (0.0, 0.0, -1.0)  # 常规朝上；加载时归一化
    spin_direction: Literal[1, -1]
    max_thrust_n: float = Field(gt=0, allow_inf_nan=False)
    torque_to_thrust_ratio: float = Field(gt=0, allow_inf_nan=False)  # 单位 m
    motor_time_constant_s: float = Field(gt=0, allow_inf_nan=False)
    prop_radius_m: float = Field(gt=0, allow_inf_nan=False)

    @field_validator("thrust_axis")
    @classmethod
    def _normalize_axis(cls, v: Vec3) -> Vec3:
        n = math.sqrt(sum(c * c for c in v))
        if n < 1e-9:
            raise ValueError("thrust_axis must be non-zero")
        return (v[0] / n, v[1] / n, v[2] / n)


class Power(_Frozen):
    battery_mass_kg: float = Field(ge=0, allow_inf_nan=False)
    capacity_wh: float = Field(gt=0, allow_inf_nan=False)
    max_discharge_w: float = Field(gt=0, allow_inf_nan=False)


class Payload(_Frozen):
    mass_kg: float = Field(ge=0, allow_inf_nan=False, default=0.0)
    position_m: Vec3 = (0.0, 0.0, 0.0)


class Controller(_Frozen):
    type: Literal["cascaded_pid", "lqr", "mpc"] = "cascaded_pid"
    auto_scale_gains: bool = True
    params: dict[str, float] = Field(default_factory=dict)


class DroneIR(_Frozen):
    schema_version: str = SCHEMA_VERSION
    ir_hash: str = ""
    parent_ir_hash: Optional[str] = None
    airframe: Airframe
    rotors: tuple[Rotor, ...] = Field(min_length=3)
    power: Power
    payload: Payload = Field(default_factory=Payload)
    controller: Controller = Field(default_factory=Controller)

    @model_validator(mode="after")
    def _check(self) -> "DroneIR":
        ids = [r.id for r in self.rotors]
        if len(set(ids)) != len(ids):
            raise ValueError("rotor ids must be unique")
        if self.ir_hash and self.ir_hash != self.compute_hash():
            raise ValueError("ir_hash does not match content (IR is immutable)")
        return self

    # -- 内容寻址 ----------------------------------------------------------
    def canonical_dict(self) -> dict:
        d = self.model_dump(mode="json", exclude={"ir_hash", "parent_ir_hash"})
        d["rotors"] = sorted(d["rotors"], key=lambda r: r["id"])  # 旋翼顺序无关
        return _canon(d)

    def compute_hash(self) -> str:
        return _sha256_json(self.canonical_dict())

    def finalize(self, parent_hash: Optional[str] = None) -> "DroneIR":
        """返回带 ir_hash 的副本（幂等）。"""
        h = self.compute_hash()
        parent = parent_hash if parent_hash is not None else self.parent_ir_hash
        if self.ir_hash == h and self.parent_ir_hash == parent:
            return self
        return self.model_copy(update={"ir_hash": h, "parent_ir_hash": parent})


# --------------------------------------------------------------------------
# (3) TestScenario
# --------------------------------------------------------------------------
class Mission(_Frozen):
    type: Literal["hover", "step_response", "waypoints"] = "hover"
    # 扩展字段（契约之外）：起始/悬停高度，向上为正（内部换算为 FRD 的负 z）
    altitude_m: float = Field(default=5.0, gt=0, allow_inf_nan=False)
    # step_response：t=step_time_s 时位置设定值阶跃 step_m（NED，米）
    step_m: Vec3 = (1.0, 0.0, 0.0)
    step_time_s: float = Field(default=1.0, ge=0, allow_inf_nan=False)
    # waypoints：[{"t_s": 0, "position_m": [x, y, z]}, ...]，z 为 NED（向上为负）
    waypoints: Optional[list[dict[str, Any]]] = None

    @model_validator(mode="after")
    def _check(self) -> "Mission":
        if self.type == "waypoints" and not self.waypoints:
            raise ValueError("mission.type == 'waypoints' requires waypoints")
        return self


class Wind(_Frozen):
    type: Literal["none", "constant", "gust"] = "none"
    # constant：恒定风速；gust：t∈[2,6]s 叠加 1-cos 阵风，峰值为该向量（NED，m/s）
    velocity_m_s: Vec3 = (0.0, 0.0, 0.0)


class Environment(_Frozen):
    air_density_kg_m3: float = Field(default=1.225, gt=0, allow_inf_nan=False)
    wind: Wind = Field(default_factory=Wind)


class FaultInjection(_Frozen):
    trigger_time_s: float = Field(ge=0, allow_inf_nan=False)
    target_rotor_id: str
    fault_type: Literal["motor_out", "thrust_loss"]
    severity: float = Field(gt=0, le=1, allow_inf_nan=False)  # 推力损失比例


class DomainRandomization(_Frozen):
    enabled: bool = False
    trials: int = Field(default=5, ge=1)
    mass_variance_pct: float = Field(default=10.0, ge=0, allow_inf_nan=False)


class TestScenario(_Frozen):
    __test__ = False  # 避免 pytest 误收集

    scenario_id: str
    version: str = "1"
    duration_s: float = Field(gt=0, allow_inf_nan=False)
    sim_dt_s: float = Field(default=0.004, gt=0, allow_inf_nan=False)
    mission: Mission = Field(default_factory=Mission)
    environment: Environment = Field(default_factory=Environment)
    fault_injections: tuple[FaultInjection, ...] = ()
    domain_randomization: Optional[DomainRandomization] = None

    def content_hash(self) -> str:
        return _sha256_json(_canon(self.model_dump(mode="json")))


# --------------------------------------------------------------------------
# (4) EvalResult
# --------------------------------------------------------------------------
Level = Literal["L1", "L2", "L3"]
Status = Literal["PASSED", "REJECTED_CONSTRAINT", "CRASHED", "TIMEOUT"]


class Violation(BaseModel):
    rule: str
    actual: float
    limit: float
    message: str = ""


class Artifacts(BaseModel):
    telemetry_parquet_uri: Optional[str] = None
    replay_json_uri: Optional[str] = None


class EvalResult(BaseModel):
    eval_id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    cache_key: str = ""
    ir_hash: str
    scenario_id: str
    evaluator_level: Level
    execution_time_ms: float = 0.0
    status: Status
    violations: list[Violation] = Field(default_factory=list)
    metrics: dict[str, float] = Field(default_factory=dict)
    fitness_score: float = 0.0
    artifacts: Optional[Artifacts] = None
    error: Optional[str] = None  # 扩展字段：CRASHED 时的异常摘要
    replay_frames: list[list[float]] = Field(default_factory=list)

    @property
    def feasible(self) -> bool:
        return self.status == "PASSED" and not self.violations


def make_cache_key(ir_hash: str, scenario: TestScenario, level: str, evaluator_version: str) -> str:
    """确定性缓存键。schema_version、场景内容、评估器版本都入 Key。"""
    raw = "|".join([SCHEMA_VERSION, ir_hash, scenario.content_hash(), level, evaluator_version])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# (1) DesignGoal
# --------------------------------------------------------------------------
class SearchDimension(BaseModel):
    param_path: str  # 如 "rotors[*].arm_length_m"、"power.capacity_wh"
    type: Literal["continuous", "discrete", "categorical"]
    bounds: Optional[tuple[float, float]] = None
    choices: Optional[list[str | float]] = None

    @model_validator(mode="after")
    def _check(self) -> "SearchDimension":
        if self.type == "continuous":
            if self.bounds is None or not self.bounds[0] < self.bounds[1]:
                raise ValueError(f"{self.param_path}: continuous needs bounds with lo < hi")
        elif self.type == "categorical":
            if not self.choices:
                raise ValueError(f"{self.param_path}: categorical needs choices")
        else:
            if not self.choices and self.bounds is None:
                raise ValueError(f"{self.param_path}: discrete needs choices or integer bounds")
        return self


class Constraint(BaseModel):
    metric: str
    operator: Literal["<=", ">=", "=="]
    limit: float

    def check(self, metrics: dict[str, float]) -> Optional[Violation]:
        if self.metric not in metrics:
            return None  # 该指标尚未由当前层级产出，留给更高层级检查
        a = metrics[self.metric]
        tol = 1e-9 * max(1.0, abs(self.limit))
        ok = (
            a <= self.limit + tol
            if self.operator == "<="
            else a >= self.limit - tol
            if self.operator == ">="
            else abs(a - self.limit) <= 1e-6 * max(1.0, abs(self.limit))
        )
        if ok:
            return None
        return Violation(rule=f"{self.metric} {self.operator} {self.limit:g}", actual=a, limit=self.limit)


class Objective(BaseModel):
    metric: str
    direction: Literal["maximize", "minimize"]
    weight: float = 1.0


class Budget(BaseModel):
    max_generations: int = 20
    max_l1_evals: int = 2000
    max_l2_evals: int = 200
    max_l3_evals: int = 10
    timeout_sec: float = 600.0


class DesignGoal(BaseModel):
    goal_id: str
    name: str
    search_space: list[SearchDimension]
    constraints: list[Constraint] = Field(default_factory=list)
    objectives: list[Objective]
    budget: Budget = Field(default_factory=Budget)

    @model_validator(mode="after")
    def _check(self) -> "DesignGoal":
        if not self.objectives:
            raise ValueError("at least one objective is required")
        return self
