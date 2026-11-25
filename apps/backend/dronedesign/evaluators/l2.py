"""L2 轻量动力学层：RK4 刚体、一级电机模型、PID/LQR、故障与域随机化。

要点：
  * 控制器使用名义质量/惯量；被控对象使用（可能被随机化后的）真实质量 → 考验鲁棒性；
  * 故障：物理上立即生效，控制分配在 trigger + 0.15 s 后"得知"（理想化 FDI）；
  * 全程确定性：领域随机化的种子由 (ir_hash, scenario) 派生，因此结果可缓存、可复现。
"""
from __future__ import annotations

import asyncio
from bisect import bisect_right
import math
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy.linalg import solve_continuous_are

from ..physics import (
    AVIONICS_W,
    G,
    PACK_OPEN_CIRCUIT_V,
    USABLE_DOD,
    alloc_matrix4,
    angular_drag_coeff,
    battery_power_limit,
    battery_terminal_voltage,
    mass_properties,
    parasitic_drag_coeff,
    rotor_arrays,
    rotor_power_coeff,
    wrench_matrix,
)
from ..schema import DroneIR, EvalResult, TestScenario, Violation
from ..spi import IEvaluator

FDI_DELAY_S = 0.15
REF_TAU_S = 0.7  # 设定值一阶平滑时间常数
MAX_TILT_CMD = 0.6 * G  # 水平/垂直期望加速度上限
CRASH_TILT_DEG = 85.0
SUPPORTED_L2_CONTROLLERS = ("cascaded_pid", "lqr")


class SimTimeout(Exception):
    pass


@dataclass
class SimOutput:
    crashed: bool
    t_crash: float
    metrics: dict[str, float]
    frames: list[list[float]] = field(default_factory=list)  # [t,x,y,z,qw,qx,qy,qz]


def _quat_to_R(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


def _wind(sc: TestScenario, t: float) -> np.ndarray:
    w = sc.environment.wind
    v = np.array(w.velocity_m_s, float)
    if w.type == "none":
        return np.zeros(3)
    if w.type == "constant":
        return v
    phase = (t - sc.gust_start_s) / sc.gust_duration_s
    if 0.0 <= phase <= 1.0:
        return v * 0.5 * (1.0 - math.cos(2.0 * math.pi * phase))
    return np.zeros(3)


def _gains(ir: DroneIR) -> dict[str, float]:
    p = ir.controller.params
    tau_max = max(r.motor_time_constant_s for r in ir.rotors)
    if ir.controller.auto_scale_gains:
        kr = float(np.clip(0.4 / tau_max, 6.0, 40.0))  # 保证 Kr·τ ≈ 0.4（速率环阻尼 ≳ 0.8）
        katt = kr / 3.5
        wn = katt / 3.5
        d = {"rate_kr": kr, "att_kp": katt, "pos_kp": wn**2, "pos_kd": 1.8 * wn, "pos_ki": 0.15 * wn**2}
    else:
        d = {"rate_kp": 0.1, "att_kp": 3.0, "pos_kp": 0.6, "pos_kd": 1.4, "pos_ki": 0.1}
    d.update({k: float(v) for k, v in p.items()})
    return d


def _perturbed(ir: DroneIR, scale: float, cg_shift: np.ndarray) -> DroneIR:
    if scale == 1.0 and not np.any(cg_shift):
        return ir
    base_mass = ir.airframe.base_mass_kg * scale
    total_mass = base_mass + ir.power.battery_mass_kg + ir.payload.mass_kg
    base_cg = np.asarray(ir.airframe.cg_offset_m) + cg_shift * (total_mass / base_mass)
    af = ir.airframe.model_copy(
        update={
            "base_mass_kg": base_mass,
            "inertia_diag_kg_m2": tuple(i * scale for i in ir.airframe.inertia_diag_kg_m2),
            "cg_offset_m": tuple(base_cg),
        }
    )
    return ir.model_copy(update={"airframe": af})


def _reference(sc: TestScenario):
    m = sc.mission
    base = np.array([0.0, 0.0, -m.altitude_m])
    zero = np.zeros(3)
    if m.type == "hover":
        return base, lambda t: (base, zero)
    if m.type == "step_response":
        tgt = base + np.array(m.step_m, float)
        return base, lambda t: (tgt if t >= m.step_time_s else base, zero)

    # The waypoint at a repeated timestamp replaces the previous one, as in legacy scenarios.
    points = {0.0: base}
    points.update((max(0.0, float(w.get("t_s", 0.0))), np.asarray(w["position_m"], dtype=float))
                  for w in m.waypoints or [])
    times = sorted(points)
    positions = [points[t] for t in times]

    def interpolate(t: float) -> tuple[np.ndarray, np.ndarray]:
        if t <= times[0] or t >= times[-1]:
            return positions[0 if t <= times[0] else -1], zero
        i = bisect_right(times, t) - 1
        duration = times[i + 1] - times[i]
        s = (t - times[i]) / duration
        delta = positions[i + 1] - positions[i]
        # Quintic with zero endpoint velocity and acceleration, joining each leg at rest.
        progress = s**3 * (10 + s * (-15 + 6 * s))
        speed = 30 * s**2 * (1 - s)**2 / duration
        return positions[i] + progress * delta, speed * delta

    return positions[0], interpolate


def _rk4_step(rhs, t: float, state: np.ndarray, dt: float) -> np.ndarray:
    k1 = rhs(t, state)
    k2 = rhs(t + dt/2, state + dt/2 * k1)
    k3 = rhs(t + dt/2, state + dt/2 * k2)
    k4 = rhs(t + dt, state + dt * k3)
    return state + dt/6 * (k1 + 2*k2 + 2*k3 + k4)


def _cross(a, b):
    ax, ay, az = a
    bx, by, bz = b
    return np.array([ay*bz - az*by, az*bx - ax*bz, ax*by - ay*bx])


def _hover_lqr(mass, inertia, linear_drag, motor_tau):
    # [position, velocity, small attitude angles, body rates, actuator accelerations].
    # The commanded thrust and moments are expressed as linear/angular accelerations.
    A = np.zeros((16, 16))
    B = np.zeros((16, 4))
    A[:3, 3:6] = np.eye(3)
    A[3:6, 3:6] = -np.diag(linear_drag) / mass
    A[3, 7], A[4, 6], A[5, 12] = -G, G, -1
    A[6:9, 9:12] = np.eye(3)
    A[9:12, 9:12] = -np.linalg.solve(inertia, np.diag(angular_drag_coeff(inertia)))
    A[9:12, 13:16] = np.eye(3)
    A[12:16, 12:16] = -np.eye(4) / motor_tau
    B[12:16] = np.eye(4) / motor_tau
    Q = np.diag([8, 8, 12, 5, 5, 8, 18, 18, 8, .7, .7, 1, .03, .001, .001, .003])
    R = np.diag([1, .07, .07, .1])
    return np.linalg.solve(R, B.T @ solve_continuous_are(A, B, Q, R))


def simulate(
    ir: DroneIR,
    scenario: TestScenario,
    *,
    mass_scale: float = 1.0,
    thrust_scale: float | np.ndarray = 1.0,
    cg_shift_m: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
    record_every: int = 0,
    wall_deadline: Optional[float] = None,
) -> SimOutput:
    # ---- 名义（控制器认知）与真实（被控对象）质量特性 -----------------------
    nom = mass_properties(ir)
    act_ir = _perturbed(ir, mass_scale, np.asarray(cg_shift_m))
    act = mass_properties(act_ir)
    arr = rotor_arrays(ir)
    n = len(ir.rotors)
    rho = scenario.environment.air_density_kg_m3
    coeff = rotor_power_coeff(ir, rho)
    ids = [r.id for r in ir.rotors]

    W_nom = wrench_matrix(ir, nom.cg)
    A4_nom = alloc_matrix4(W_nom)
    W_act = wrench_matrix(act_ir, act.cg)
    Fmat = W_act[:3]  # 3×n
    Mmat = W_act[3:]  # 3×n
    J_nom, J_act = nom.inertia, act.inertia
    J_nom_inv = np.linalg.inv(J_nom)
    J_act_inv = np.linalg.inv(J_act)
    M_nom, M_act = nom.mass, act.mass
    cd = np.array(ir.airframe.linear_drag_coeff, float)
    cd2 = parasitic_drag_coeff(rho)
    angular_drag = angular_drag_coeff(J_act)
    tmax, tau = arr["tmax"], arr["tau"]
    power_limit = battery_power_limit(ir.power.max_discharge_w)

    lqr_gain = _hover_lqr(M_nom, J_nom, cd, float(np.mean(tau))) if ir.controller.type == "lqr" else None
    if lqr_gain is None:
        gains = _gains(ir)
        auto = ir.controller.auto_scale_gains
        kr = gains.get("rate_kr", 0.0)
        rate_gain = np.array([kr, kr, 0.5 * kr]) if auto else gains.get("rate_kp", 0.0)
        att_kp, pos_kp, pos_kd, pos_ki = gains["att_kp"], gains["pos_kp"], gains["pos_kd"], gains["pos_ki"]

    dt = scenario.sim_dt_s
    n_steps = int(round(scenario.duration_s / dt))
    alpha = 1.0 - np.exp(-dt / tau)

    # ---- 故障时间表 ------------------------------------------------------
    faults = []
    for f in scenario.fault_injections:
        if f.target_rotor_id not in ids:
            raise ValueError(f"fault target rotor {f.target_rotor_id!r} not in IR")
        loss = 1.0 if f.fault_type == "motor_out" else f.severity
        faults.append((f.trigger_time_s, ids.index(f.target_rotor_id), min(loss, 1.0)))
    g_phys = np.ones(n)
    g_known = np.ones(n)
    faults_active_known = False

    def build_alloc(gk: np.ndarray, has_fault: bool):
        """返回 (P, A_eff, mask, S)。T = T0 + P·(u − A_eff·T0)：在冗余零空间内取最接近均匀分配的解，
        避免对侧电机被推到 0 N 而丧失调节余量。"""
        A = A4_nom * gk[None, :]
        mask = (gk > 0).astype(float)
        # 活动旋翼 ≤5 且有故障时放弃偏航通道：精确偏航平衡会把对侧电机压到 0 N，
        # 失去滚转/俯仰调节余量；让机体自旋、保住推力与姿态（与多旋翼容错文献一致）。
        yaw_w = 0.0 if (has_fault and int(mask.sum()) <= 5) else 1.0
        wd = np.array([1.0, 1.0, 1.0, yaw_w])
        P = np.linalg.pinv(wd[:, None] * A) * wd[None, :]
        return P, A, mask, float(np.sum(A[0]))

    def allocate(alloc, u: np.ndarray) -> np.ndarray:
        P, A, mask, S = alloc
        if S <= 1e-9:
            return np.zeros(n)
        T0 = (u[0] / S) * mask
        return T0 + P @ (u - A @ T0)

    def rotor_load(thrust):
        return float(coeff @ (thrust * np.sqrt(thrust)))

    def motor_limits(command, loaded_thrust, effectiveness):
        voltage = battery_terminal_voltage(min(power_limit, AVIONICS_W + rotor_load(loaded_thrust)))
        thrust = np.clip(command, 0.0, tmax * (voltage / PACK_OPEN_CIRCUIT_V)**2)
        demand = rotor_load(thrust * effectiveness)
        if demand + AVIONICS_W > power_limit and demand > 0:
            thrust *= (max(0.0, power_limit - AVIONICS_W) / demand)**(2/3)
        return thrust

    alloc = build_alloc(g_known, False)

    # ---- 初值 ------------------------------------------------------------
    start, ref_fn = _reference(scenario)
    state = np.zeros(13)  # world position and velocity, body-to-world quaternion (wxyz), body rates
    state[:3], state[6] = start, 1.0
    hover = np.array([M_nom * G, 0, 0, 0])
    hover_command = allocate(alloc, hover)
    T_state = motor_limits(hover_command, np.clip(hover_command, 0, tmax) * thrust_scale, thrust_scale)
    sp_f = start.copy()
    integ = np.zeros(3)
    g_vec = np.array([0.0, 0.0, G])
    n0 = np.array([0.0, 0.0, -1.0])
    waypoints = scenario.mission.type == "waypoints"

    def rigid_body_rhs(t_stage, y):
        velocity, quat, omega = y[3:6], y[6:10], y[10:13]
        rot = _quat_to_R(quat / np.linalg.norm(quat))
        # Exact first-order motor response within the held command, sampled by RK4.
        thrust = (T_state + (1.0 - np.exp(-(t_stage - t) / tau)) * motor_delta) * effectiveness
        v_air = rot.T @ (velocity - _wind(scenario, t_stage))
        force_b = Fmat @ thrust - (cd + cd2 * np.abs(v_air)) * v_air
        moment_b = Mmat @ thrust - angular_drag * omega - _cross(omega, J_act @ omega)
        q_dot = np.empty(4)
        q_dot[0] = -quat[1:] @ omega
        q_dot[1:] = quat[0] * omega + _cross(quat[1:], omega)
        return np.concatenate((velocity, rot @ force_b / M_act + g_vec, 0.5 * q_dot, J_act_inv @ moment_b))

    err_hist = np.zeros(n_steps)
    tilt_hist = np.zeros(n_steps)
    pwr_hist = np.zeros(n_steps)
    sat_hist = np.zeros(n_steps)
    util_hist = np.zeros(n_steps)
    frames: list[list[float]] = [[0.0, *map(float, state[:3]), *map(float, state[6:10])]] if record_every else []
    min_voltage = PACK_OPEN_CIRCUIT_V
    crashed, t_crash, k_end = False, float("inf"), n_steps

    for k in range(n_steps):
        t = k * dt
        if wall_deadline is not None and time.perf_counter() >= wall_deadline:
            raise SimTimeout()

        # 故障：物理立即生效；控制分配延迟得知
        changed = False
        for (tf, idx, loss) in faults:
            if t >= tf:
                g_phys[idx] = min(g_phys[idx], 1.0 - loss)
            if t >= tf + FDI_DELAY_S and g_known[idx] > 1.0 - loss:
                g_known[idx] = min(g_known[idx], 1.0 - loss)
                changed = True
        if changed:
            faults_active_known = True
            alloc = build_alloc(g_known, faults_active_known)

        p, v, q, w = state[:3], state[3:6], state[6:10], state[10:13]
        R = _quat_to_R(q)

        # ---- 参考 ---------------------------------------------------------
        target, v_ref = ref_fn(t)
        if waypoints:
            sp_f = target
        else:
            v_ref = (target - sp_f) / REF_TAU_S
            sp_f = sp_f + v_ref * dt

        yaw = math.atan2(R[1, 0], R[0, 0])
        if lqr_gain is not None:
            attitude = [math.atan2(R[2, 1], R[2, 2]), math.asin(float(np.clip(-R[2, 0], -1, 1))), yaw]
            actuator = A4_nom @ (T_state * g_known) - hover
            x = np.concatenate((p - sp_f, v - v_ref, attitude, w,
                                [actuator[0] / M_nom], J_nom_inv @ actuator[1:]))
            command = -lqr_gain @ x
            u = np.r_[M_nom * max(0.0, G + command[0]), J_nom @ command[1:]]
        else:
            e_p = sp_f - p
            integ = np.clip(integ + e_p * dt, -3.0, 3.0)
            a_des = pos_kp * e_p + pos_kd * (v_ref - v) + pos_ki * integ
            F_w = M_nom * (np.clip(a_des, -MAX_TILT_CMD, MAX_TILT_CMD) - g_vec)
            z_des = F_w / max(float(np.linalg.norm(F_w)), 1e-9)
            thr_dir = R @ n0
            T_total = max(float(F_w @ thr_dir), 0.0)
            e_b = R.T @ _cross(thr_dir, z_des)
            yaw_err = (-yaw + math.pi) % (2 * math.pi) - math.pi
            w_cmd = np.array([att_kp * e_b[0], att_kp * e_b[1], float(np.clip(0.6 * att_kp * yaw_err, -1.5, 1.5))])
            w_cmd[:2] = np.clip(w_cmd[:2], -4.0, 4.0)
            Mcmd = rate_gain * (w_cmd - w)
            if auto:
                Mcmd = J_nom @ Mcmd + _cross(w, J_nom @ w)
            u = np.r_[T_total, Mcmd]

        # ---- 分配 -----------------------------------------------------------
        T_cmd_raw = allocate(alloc, u)
        effectiveness = g_phys * thrust_scale
        T_cmd = motor_limits(T_cmd_raw, T_state * effectiveness, effectiveness)
        sat_hist[k] = float(np.any(np.abs(T_cmd - T_cmd_raw) > 1e-9))

        # ---- 被控对象 -------------------------------------------------------
        motor_delta = T_cmd - T_state
        state = _rk4_step(rigid_body_rhs, t, state, dt)
        T_state = T_state + alpha * motor_delta
        T_act = T_state * effectiveness
        p, q = state[:3], state[6:10]
        q /= np.linalg.norm(q)

        # ---- 记录与崩溃判据 ------------------------------------------------
        tilt = math.degrees(math.acos(max(-1.0, min(1.0, _quat_to_R(q)[2, 2]))))
        reference = ref_fn((k + 1) * dt)[0] if waypoints else sp_f
        err = float(np.linalg.norm(p - reference))
        err_hist[k] = err
        tilt_hist[k] = tilt
        load = min(power_limit, AVIONICS_W + rotor_load(T_act))
        voltage = battery_terminal_voltage(load)
        min_voltage = min(min_voltage, voltage)
        pwr_hist[k] = load * PACK_OPEN_CIRCUIT_V / voltage  # includes pack resistive losses
        util_hist[k] = float(np.max(T_act / (tmax * thrust_scale)))
        if record_every and k % record_every == 0:
            frames.append([(k + 1) * dt, *map(float, p), *map(float, q)])
        if (not np.all(np.isfinite(state))) or p[2] >= 0.0 or tilt > CRASH_TILT_DEG or err > 25.0:
            crashed, t_crash, k_end = True, (k + 1) * dt, k + 1
            break

    m = max(k_end, 1)
    e, tl, pw = err_hist[:m], tilt_hist[:m], pwr_hist[:m]
    mean_p = float(np.mean(pw)) if np.all(np.isfinite(pw)) else float("inf")
    metrics = {
        "tracking_rmse_m": float(np.sqrt(np.mean(e**2))),
        "max_pos_err_m": float(np.max(e)),
        "final_pos_err_m": float(np.mean(e[int(0.9 * m):])),
        "max_tilt_deg": float(np.max(tl)),
        "mean_power_w": mean_p,
        "energy_wh": float(np.sum(pw) * dt / 3600.0),
        "saturation_frac": float(np.mean(sat_hist[:m])),
        "max_rotor_util": float(np.max(util_hist[:m])),
        "min_battery_voltage_v": min_voltage,
        "flight_time_min_sim": USABLE_DOD * ir.power.capacity_wh / mean_p * 60.0 if mean_p > 0 else 0.0,
    }
    return SimOutput(crashed, t_crash, metrics, frames)


_AGG_WORST_KEYS = ("tracking_rmse_m", "max_pos_err_m", "max_tilt_deg")


def _trial_inputs(ir: DroneIR, scenario: TestScenario, seed: int):
    yield 1.0, 1.0, (0.0, 0.0, 0.0)
    dr = scenario.domain_randomization
    if dr is None or not dr.enabled:
        return
    trial_seed = int((ir.ir_hash or ir.compute_hash())[:16], 16) ^ int(scenario.content_hash()[:16], 16) ^ seed
    rng = np.random.default_rng(trial_seed)
    mass_span = min(dr.mass_variance_pct / 100, np.nextafter(1.0, 0.0))
    thrust_span = dr.thrust_variance_pct / 100
    cg_span = dr.cg_offset_variance_m
    rotor_order = sorted(range(len(ir.rotors)), key=lambda i: ir.rotors[i].id)
    for _ in range(dr.trials):
        mass = 1.0 + rng.uniform(-mass_span, mass_span)
        thrust = np.empty(len(rotor_order))
        thrust[rotor_order] = 1.0 + rng.uniform(-thrust_span, thrust_span, size=len(rotor_order))
        yield mass, thrust, rng.uniform(-cg_span, cg_span, size=3)


def evaluate_l2_sync(ir: DroneIR, scenario: TestScenario, timeout_s: float = 60.0, *, record_every: int = 0, seed: int = 0) -> EvalResult:
    t0 = time.perf_counter()
    deadline = t0 + timeout_s
    viol: list[Violation] = []
    metrics: dict[str, float] = {}
    err = None
    frames = []
    try:
        if ir.controller.type not in SUPPORTED_L2_CONTROLLERS:
            viol.append(Violation(rule="unsupported_controller", actual=0.0, limit=0.0,
                                  message=f"L2 控制器可选 {', '.join(SUPPORTED_L2_CONTROLLERS)}，收到 {ir.controller.type}"))
            status = "REJECTED_CONSTRAINT"
        else:
            outs = [simulate(ir, scenario, mass_scale=mass, thrust_scale=thrust, cg_shift_m=cg,
                             wall_deadline=deadline, record_every=record_every if i == 0 else 0)
                    for i, (mass, thrust, cg) in enumerate(_trial_inputs(ir, scenario, seed))]
            nominal = outs[0]
            frames = nominal.frames
            keys = nominal.metrics.keys()
            metrics = {k: float(np.mean([o.metrics[k] for o in outs])) for k in keys}
            for k in _AGG_WORST_KEYS:
                metrics[f"{k}_worst"] = float(np.max([o.metrics[k] for o in outs]))
            metrics["crash_rate"] = float(np.mean([o.crashed for o in outs]))
            if any(o.crashed for o in outs):
                status = "CRASHED"
                viol.append(Violation(rule="crashed", actual=min(o.t_crash for o in outs), limit=scenario.duration_s,
                                      message="名义或随机化试验发生失稳"))
            else:
                status = "PASSED"
    except SimTimeout:
        status = "TIMEOUT"
        err = f"exceeded {timeout_s}s wall time"
    except Exception as e:  # noqa: BLE001
        status, err = "CRASHED", f"{type(e).__name__}: {e}"
    return EvalResult(
        ir_hash=ir.ir_hash,
        scenario_id=scenario.scenario_id,
        evaluator_level="L2",
        execution_time_ms=(time.perf_counter() - t0) * 1e3,
        status=status,
        violations=viol,
        metrics=metrics,
        error=err,
        replay_frames=frames,
    )


def _worker(ir_json: str, sc_json: str, timeout_s: float) -> str:
    ir = DroneIR.model_validate_json(ir_json)
    sc = TestScenario.model_validate_json(sc_json)
    return evaluate_l2_sync(ir, sc, timeout_s).model_dump_json()


class L2Evaluator(IEvaluator):
    """max_workers=0：线程内执行；>0：多进程无头 Worker 池（文档 L2 执行形态）。"""

    level = "L2"
    version = "core-6dof/3.0.0"

    def __init__(self, max_workers: int = 0, timeout_s: float = 60.0):
        self.max_workers = max_workers
        self.timeout_s = timeout_s
        self._pool: Optional[ProcessPoolExecutor] = None

    async def evaluate(self, ir: DroneIR, scenario: TestScenario) -> EvalResult:
        loop = asyncio.get_running_loop()
        if self.max_workers <= 0:
            return await asyncio.to_thread(evaluate_l2_sync, ir, scenario, self.timeout_s)
        if self._pool is None:
            self._pool = ProcessPoolExecutor(max_workers=self.max_workers)
        out = await loop.run_in_executor(
            self._pool, _worker, ir.model_dump_json(), scenario.model_dump_json(), self.timeout_s
        )
        return EvalResult.model_validate_json(out)

    def close(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=True, cancel_futures=True)
            self._pool = None
