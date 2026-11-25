"""L1/L2 共用的物理内核：质量特性合成、控制分配矩阵、功率模型。

约定（全部 SI + FRD）：
  * 推力 F_i = T_i · a_i（a_i 为单位推力轴）；
  * 力矩 M_i = (r_i − r_cg) × F_i + spin_i · κ_i · T_i · a_i（反扭矩符号约定在 L1/L2 内一致即可）；
  * 电池视为位于机体原点的质点，电机/桨质量并入 base_mass；
  * 功率：动量理论悬停功率 P = T^1.5 / sqrt(2ρA) / (FoM·η)（线性推力-油门假设）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .schema import DroneIR

G = 9.80665
FOM = 0.65  # 桨的品质因数
MOTOR_ETA = 0.80  # 电机+电调效率
AVIONICS_W = 5.0  # 航电固定功耗
USABLE_DOD = 0.80  # 可用放电深度
PACK_OPEN_CIRCUIT_V = 14.8  # 名义 4S 锂电池组
PACK_RESISTANCE_OHM = 0.04
PARASITIC_DRAG_AREA_M2 = (0.035, 0.035, 0.055)  # 机体三轴等效 CdA
ANGULAR_DAMPING_RATE_S = (0.55, 0.55, 0.30)


@dataclass(frozen=True)
class MassProps:
    mass: float
    cg: np.ndarray  # (3,)
    inertia: np.ndarray  # (3,3) 绕合成重心


def mass_properties(ir: DroneIR) -> MassProps:
    comps: list[tuple[float, np.ndarray, np.ndarray]] = []
    af = ir.airframe
    comps.append((af.base_mass_kg, np.array(af.cg_offset_m, float), np.diag(af.inertia_diag_kg_m2)))
    comps.append((ir.power.battery_mass_kg, np.zeros(3), np.zeros((3, 3))))
    comps.append((ir.payload.mass_kg, np.array(ir.payload.position_m, float), np.zeros((3, 3))))
    m_tot = sum(c[0] for c in comps)
    cg = sum(c[0] * c[1] for c in comps) / m_tot
    J = np.zeros((3, 3))
    for m, r, I in comps:
        d = r - cg
        J += I + m * (float(d @ d) * np.eye(3) - np.outer(d, d))
    return MassProps(m_tot, cg, J)


def rotor_arrays(ir: DroneIR) -> dict[str, np.ndarray]:
    R = ir.rotors
    return {
        "pos": np.array([r.position_m for r in R], float),  # (n,3)
        "axis": np.array([r.thrust_axis for r in R], float),  # (n,3)
        "spin": np.array([r.spin_direction for r in R], float),
        "kappa": np.array([r.torque_to_thrust_ratio for r in R], float),
        "tmax": np.array([r.max_thrust_n for r in R], float),
        "tau": np.array([r.motor_time_constant_s for r in R], float),
        "rad": np.array([r.prop_radius_m for r in R], float),
    }


def wrench_matrix(ir: DroneIR, cg: np.ndarray) -> np.ndarray:
    """6×n：每列是单位推力产生的 [Fx,Fy,Fz,Mx,My,Mz]（机体系，绕 cg）。"""
    a = rotor_arrays(ir)
    arm = a["pos"] - cg
    force = a["axis"]  # (n,3)
    moment = np.cross(arm, force) + (a["spin"] * a["kappa"])[:, None] * force
    return np.vstack([force.T, moment.T])


def alloc_matrix4(W6: np.ndarray) -> np.ndarray:
    """4×n：[总升力(向上为正), Mx, My, Mz]，用于可控性与分配。"""
    return np.vstack([-W6[2], W6[3], W6[4], W6[5]])


def rotor_power_coeff(ir: DroneIR, rho: float) -> np.ndarray:
    """P_i = coeff_i · T_i^1.5 （瓦）。"""
    rad = np.array([r.prop_radius_m for r in ir.rotors])
    area = math.pi * rad**2
    return 1.0 / (np.sqrt(2.0 * rho * area) * FOM * MOTOR_ETA)


def parasitic_drag_coeff(air_density: float) -> np.ndarray:
    return 0.5 * air_density * np.asarray(PARASITIC_DRAG_AREA_M2)


def angular_drag_coeff(inertia: np.ndarray) -> np.ndarray:
    return np.diag(inertia) * np.asarray(ANGULAR_DAMPING_RATE_S)


def battery_power_limit(max_discharge_w: float) -> float:
    return min(max_discharge_w, PACK_OPEN_CIRCUIT_V**2 / (4 * PACK_RESISTANCE_OHM))


def battery_terminal_voltage(load_w: float) -> float:
    """High-voltage solution of P = V I and V = V_oc - R I."""
    return 0.5 * (PACK_OPEN_CIRCUIT_V + math.sqrt(max(0.0, PACK_OPEN_CIRCUIT_V**2 - 4 * PACK_RESISTANCE_OHM * load_w)))
