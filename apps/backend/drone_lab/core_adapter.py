"""Bridge the supplied dronedesign core to the persistent application's contracts."""
import math

from dronedesign import schema as core
from dronedesign.evaluators import evaluate_l1_sync, evaluate_l2_sync
from dronedesign.evaluators.l2 import _gains
from dronedesign.physics import mass_properties

from .domain import DroneIR, EvalResult, ReplayData, TestScenario, Violation


def to_core_ir(ir: DroneIR) -> core.DroneIR:
    return core.DroneIR.model_validate(ir.model_dump(mode="json")).finalize()


def from_core_ir(ir: core.DroneIR) -> DroneIR:
    return DroneIR.model_validate(ir.model_dump(mode="json", exclude={"ir_hash", "parent_ir_hash"}))


def to_core_scenario(sc: TestScenario) -> core.TestScenario:
    return core.TestScenario(
        scenario_id=sc.scenario_id, version=sc.version, duration_s=sc.duration_s, sim_dt_s=sc.sim_dt_s,
        mission=core.Mission.model_validate(sc.mission.model_dump(mode="json")),
        environment=core.Environment(air_density_kg_m3=sc.air_density_kg_m3,
            wind=core.Wind(type=sc.wind_type, velocity_m_s=sc.wind_velocity_m_s)),
        fault_injections=tuple(core.FaultInjection.model_validate(f.model_dump()) for f in sc.fault_injections),
        domain_randomization=core.DomainRandomization.model_validate(sc.domain_randomization.model_dump()),
    )


def convert_result(raw: core.EvalResult, evaluator, fidelity: str) -> EvalResult:
    if not all(math.isfinite(v) for v in raw.metrics.values()):
        return EvalResult(evaluator_level=evaluator.level, evaluator_version=evaluator.version,
            status="CRASHED", fidelity=fidelity, message="物理计算产生非有限指标")
    return EvalResult(evaluator_level=evaluator.level, evaluator_version=evaluator.version,
        status=raw.status, metrics=raw.metrics, fidelity=fidelity,
        violations=[Violation.model_validate(v.model_dump()) for v in raw.violations],
        execution_time_ms=raw.execution_time_ms, message=raw.error or "",
        replay=ReplayData(frames=raw.replay_frames) if raw.replay_frames else None)


def resolved_mass_parameters(aircraft):
    props = mass_properties(aircraft)
    return {"nominal_mass_kg": props.mass,
            **{f"cg_{axis}_m": float(props.cg[i]) for i, axis in enumerate("xyz")},
            **{f"inertia_{a}{b}_kg_m2": float(props.inertia[i,j]) for i,a in enumerate("xyz") for j,b in enumerate("xyz")}}


class CoreL1Evaluator:
    level, version = "L1", "core-static/2.1.0"

    def evaluate(self, ir, scenario, seed):
        aircraft = to_core_ir(ir)
        raw = evaluate_l1_sync(aircraft, to_core_scenario(scenario))
        result = convert_result(raw, self, "ANALYTIC")
        result.resolved_parameters = resolved_mass_parameters(aircraft)
        return result


class DynamicsEvaluator:
    level, version = "L2", "core-6dof/2.1.0"

    def __init__(self, timeout_s=30):
        self.timeout_s = timeout_s

    def evaluate(self, ir, scenario, seed):
        aircraft, sc = to_core_ir(ir), to_core_scenario(scenario)
        static = evaluate_l1_sync(aircraft, sc)
        # Bounded telemetry; the nominal trial is retained, random trials are aggregated.
        stride = max(1, math.ceil(sc.duration_s/sc.sim_dt_s/600))
        raw = evaluate_l2_sync(aircraft, sc, timeout_s=self.timeout_s, record_every=stride, seed=seed)
        raw.metrics = {**static.metrics, **raw.metrics}
        result = convert_result(raw, self, "DYNAMICS")
        result.resolved_parameters = {**resolved_mass_parameters(aircraft), **_gains(aircraft)}
        return result
