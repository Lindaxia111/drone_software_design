"""Analytic baseline and explicitly synthetic L2, never flight validation."""
import math
import random
import time

from .domain import DroneIR, EvalResult, TestScenario, Violation, content_hash


def baseline_supported(ir: DroneIR) -> bool:
    return (len(ir.rotors) == 4 and all(r.thrust_axis == (0, 0, -1) for r in ir.rotors)
            and all(r.position_m[2] == 0 for r in ir.rotors)
            and ir.airframe.cg_offset_m == (0, 0, 0) and ir.payload.position_m == (0, 0, 0))


class AnalyticEvaluator:
    level, version = "L1", "analytic-baseline/1.0.0"

    def evaluate(self, ir: DroneIR, scenario: TestScenario, seed: int) -> EvalResult:
        started = time.perf_counter()
        if not baseline_supported(ir):
            return EvalResult(evaluator_level="L1", evaluator_version=self.version,
                status="UNSUPPORTED", fidelity="ANALYTIC", message="首版仅支持共面竖直旋翼、中心重心的四旋翼基准")
        mass = ir.airframe.base_mass_kg + ir.power.battery_mass_kg + ir.payload.mass_kg
        weight = mass * 9.80665
        total_thrust = sum(r.max_thrust_n for r in ir.rotors)
        disk_area = sum(math.pi * r.prop_radius_m**2 for r in ir.rotors)
        power = weight**1.5 / math.sqrt(2*scenario.air_density_kg_m3*disk_area) / 0.65 + 8
        violations = []
        if total_thrust < weight:
            violations.append(Violation(rule="hover_thrust", actual=total_thrust, limit=weight))
        if power > ir.power.max_discharge_w:
            violations.append(Violation(rule="battery_discharge_w", actual=power, limit=ir.power.max_discharge_w))
        for i, a in enumerate(ir.rotors):
            for b in ir.rotors[i+1:]:
                distance = math.dist(a.position_m, b.position_m)
                if distance < a.prop_radius_m + b.prop_radius_m:
                    violations.append(Violation(rule="rotor_clearance_m", actual=distance, limit=a.prop_radius_m+b.prop_radius_m))
        metrics = {"total_mass_kg": mass, "thrust_to_weight_ratio": total_thrust/weight,
                   "hover_power_w": power, "flight_time_min": ir.power.capacity_wh*0.8/power*60}
        return EvalResult(evaluator_level="L1", evaluator_version=self.version,
            status="REJECTED_CONSTRAINT" if violations else "PASSED", metrics=metrics,
            violations=violations, fidelity="ANALYTIC", execution_time_ms=(time.perf_counter()-started)*1000)


class DemoEvaluator:
    level, version = "L2", "synthetic-hover/1.0.0"

    def evaluate(self, ir: DroneIR, scenario: TestScenario, seed: int) -> EvalResult:
        base = AnalyticEvaluator().evaluate(ir, scenario, seed)
        rng = random.Random(f"{ir.ir_hash}:{seed}:{content_hash(scenario.model_dump(mode='json'))}")
        wind = math.sqrt(sum(v*v for v in scenario.wind_velocity_m_s))
        margin = base.metrics["thrust_to_weight_ratio"]
        metrics = {**base.metrics, "tracking_rmse_m": round(0.035+0.11/max(margin, 0.1)+0.012*wind+rng.uniform(0, 0.018), 6)}
        return EvalResult(evaluator_level="L2", evaluator_version=self.version,
            status="PASSED", metrics=metrics, fidelity="DEMO",
            message="流程演示指标；未运行 6-DOF 动力学或真实飞控")


def cache_key(ir: DroneIR, scenario: TestScenario, evaluator, seed: int) -> str:
    return content_hash({"ir_hash": ir.ir_hash, "schema_version": ir.schema_version,
        "scenario": scenario.model_dump(mode="json"), "evaluator": evaluator.version,
        "level": evaluator.level, "seed": seed})


def constraint_violations(metrics, constraints):
    violations = []
    for c in constraints:
        if c.metric not in metrics:
            continue  # L2-only metrics are checked once produced.
        actual = metrics[c.metric]
        passed = actual <= c.limit if c.operator == "<=" else actual >= c.limit if c.operator == ">=" else math.isclose(actual, c.limit, abs_tol=1e-9)
        if not passed:
            violations.append(Violation(rule=c.metric, actual=actual, limit=c.limit))
    return violations


def pareto_indices(candidates, objectives):
    eligible = [c for c in candidates if c["status"] == "PASSED" and all(o.metric in c["metrics"] for o in objectives)]
    def vector(c):
        return [c["metrics"][o.metric] * (-1 if o.direction == "maximize" else 1) for o in objectives]
    vectors = {c["candidate_id"]: vector(c) for c in eligible}
    return [c["candidate_id"] for c in eligible if not any(
        all(a <= b for a, b in zip(v, vectors[c["candidate_id"]])) and any(a < b for a, b in zip(v, vectors[c["candidate_id"]]))
        for key, v in vectors.items() if key != c["candidate_id"])]
