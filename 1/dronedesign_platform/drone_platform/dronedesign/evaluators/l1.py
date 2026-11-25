"""L1 静态解析层：进程内纯数学计算（无 I/O），目标 1~10 ms。

产出指标：total_mass_kg, cg_offset_m, thrust_to_weight_ratio, hover_throttle,
hover_power_w, peak_power_w, discharge_margin, flight_time_min,
min_rotor_clearance_m, allocation_cond, rotor_count
内置物理硬校验（不依赖 DesignGoal）：悬停可行、可控性秩、桨盘不干涉、悬停功率不超放电上限。
"""
from __future__ import annotations

import time

import numpy as np
from scipy.optimize import lsq_linear

from ..physics import (
    AVIONICS_W,
    G,
    USABLE_DOD,
    alloc_matrix4,
    mass_properties,
    rotor_arrays,
    rotor_power_coeff,
    wrench_matrix,
)
from ..schema import DroneIR, EvalResult, TestScenario, Violation
from ..spi import IEvaluator

HOVER_RESIDUAL_TOL = 5e-3  # 悬停力/力矩残差相对 m·g 的容许值


def evaluate_l1_sync(ir: DroneIR, scenario: TestScenario) -> EvalResult:
    t0 = time.perf_counter()
    rho = scenario.environment.air_density_kg_m3
    viol: list[Violation] = []
    try:
        mp = mass_properties(ir)
        a = rotor_arrays(ir)
        n = len(ir.rotors)
        weight = mp.mass * G
        W6 = wrench_matrix(ir, mp.cg)
        A4 = alloc_matrix4(W6)

        # 1) 可控性：行归一化后求秩（总升力 + 三轴力矩，期望 4）
        An = A4 / np.maximum(np.abs(A4).max(axis=1, keepdims=True), 1e-12)
        sv = np.linalg.svd(An, compute_uv=False)
        rank = int(np.sum(sv > 1e-6 * sv[0])) if sv[0] > 0 else 0
        cond = float(sv[0] / sv[-1]) if sv[-1] > 1e-12 else float("inf")
        if rank < 4:
            viol.append(Violation(rule="controllability_rank", actual=rank, limit=4))

        # 2) 悬停可行性：有界最小二乘（Tikhonov 近似最小范数解）
        lam = 1e-4
        target = np.array([0.0, 0.0, -weight, 0.0, 0.0, 0.0])
        Aaug = np.vstack([W6, lam * np.eye(n)])
        baug = np.concatenate([target, np.zeros(n)])
        sol = lsq_linear(Aaug, baug, bounds=(np.zeros(n), a["tmax"]), method="bvls")
        T = sol.x
        resid = float(np.linalg.norm(W6 @ T - target) / weight)
        hover_ok = resid <= HOVER_RESIDUAL_TOL
        if not hover_ok:
            viol.append(Violation(rule="hover_infeasible", actual=resid, limit=HOVER_RESIDUAL_TOL,
                                  message="推力上限或几何布局无法平衡重力与力矩"))

        # 3) 功率与航时
        coeff = rotor_power_coeff(ir, rho)
        hover_p = float(np.sum(coeff * T**1.5)) + AVIONICS_W
        peak_p = float(np.sum(coeff * a["tmax"] ** 1.5)) + AVIONICS_W
        if hover_p > ir.power.max_discharge_w:
            viol.append(Violation(rule="hover_power_exceeds_discharge", actual=hover_p,
                                  limit=ir.power.max_discharge_w))
        flight_time = USABLE_DOD * ir.power.capacity_wh / hover_p * 60.0

        # 4) 桨盘包络干涉（球近似：中心距 − 半径之和）
        pos, rad = a["pos"], a["rad"]
        clearance = float("inf")
        for i in range(n):
            for j in range(i + 1, n):
                clearance = min(clearance, float(np.linalg.norm(pos[i] - pos[j]) - rad[i] - rad[j]))
        if clearance < 0:
            viol.append(Violation(rule="rotor_overlap", actual=clearance, limit=0.0))

        # 5) 其它指标
        up = float(np.sum(a["tmax"] * -a["axis"][:, 2]))
        centroid_xy = pos[:, :2].mean(axis=0)
        metrics = {
            "total_mass_kg": mp.mass,
            "cg_offset_m": float(np.linalg.norm(mp.cg[:2] - centroid_xy)),
            "thrust_to_weight_ratio": up / weight,
            "hover_throttle": float(np.max(T / a["tmax"])),
            "hover_power_w": hover_p,
            "peak_power_w": peak_p,
            "discharge_margin": ir.power.max_discharge_w / peak_p,
            "flight_time_min": flight_time,
            "min_rotor_clearance_m": clearance,
            "allocation_cond": min(cond, 1e9),
            "rotor_count": float(n),
        }
        status = "REJECTED_CONSTRAINT" if viol else "PASSED"
        err = None
    except Exception as e:  # noqa: BLE001  评估器内任何异常都归为 CRASHED，不拖垮流水线
        metrics, status, err = {}, "CRASHED", f"{type(e).__name__}: {e}"

    return EvalResult(
        ir_hash=ir.ir_hash,
        scenario_id=scenario.scenario_id,
        evaluator_level="L1",
        execution_time_ms=(time.perf_counter() - t0) * 1e3,
        status=status,
        violations=viol,
        metrics=metrics,
        error=err,
    )


class L1Evaluator(IEvaluator):
    level = "L1"
    version = "1"

    async def evaluate(self, ir: DroneIR, scenario: TestScenario) -> EvalResult:
        return evaluate_l1_sync(ir, scenario)
