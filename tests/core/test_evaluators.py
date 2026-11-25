import math
import time

import numpy as np
import pytest

from dronedesign.evaluators import evaluate_l1_sync, evaluate_l2_sync
from dronedesign.evaluators.l2 import _perturbed, _reference, _rk4_step, _trial_inputs, _wind, simulate
from dronedesign.irtools import apply_params, make_multirotor
from dronedesign.physics import PACK_OPEN_CIRCUIT_V, battery_terminal_voltage, mass_properties
from dronedesign.schema import (
    Controller,
    DomainRandomization,
    Environment,
    FaultInjection,
    Mission,
    TestScenario,
    Wind,
)

HOVER = TestScenario(scenario_id="hover", duration_s=8, sim_dt_s=0.005)
WIND_DR = TestScenario(
    scenario_id="wind_dr", duration_s=8, sim_dt_s=0.005,
    environment=Environment(wind=Wind(type="constant", velocity_m_s=(3, 0, 0))),
    domain_randomization=DomainRandomization(enabled=True, trials=2, mass_variance_pct=10),
)


def rules(res):
    return {v.rule for v in res.violations}


# ----------------------------- L1 -----------------------------------------
def test_l1_baseline_passes_with_sane_metrics():
    r = evaluate_l1_sync(make_multirotor(), HOVER)
    assert r.status == "PASSED" and not r.violations
    m = r.metrics
    assert 2.0 < m["thrust_to_weight_ratio"] < 4.0
    assert 0.2 < m["hover_throttle"] < 0.6
    assert m["min_rotor_clearance_m"] > 0 and m["flight_time_min"] > 5
    assert m["total_mass_kg"] == pytest.approx(1.2 + 60 / 180 + 0.2)


def test_l1_is_fast():
    ir = make_multirotor()
    evaluate_l1_sync(ir, HOVER)
    t = time.perf_counter()
    for _ in range(30):
        evaluate_l1_sync(ir, HOVER)
    assert (time.perf_counter() - t) / 30 < 0.02  # 文档目标 1~10 ms，测试放宽到 20 ms


def test_l1_rejects_underpowered_overlapping_and_uncontrollable():
    assert "hover_infeasible" in rules(evaluate_l1_sync(make_multirotor(max_thrust_n=3.0), HOVER))
    assert "rotor_overlap" in rules(evaluate_l1_sync(make_multirotor(prop_radius_m=0.25), HOVER))
    collinear = apply_params(make_multirotor(), {"rotors[*].position_m[1]": 0.0})
    assert "controllability_rank" in rules(evaluate_l1_sync(collinear, HOVER))


def test_l1_hover_power_exceeding_discharge_is_rejected():
    ir = apply_params(make_multirotor(), {"power.max_discharge_w": 50.0})
    assert "hover_power_exceeds_discharge" in rules(evaluate_l1_sync(ir, HOVER))


def test_l1_cg_offset_reported_and_hover_still_balanced():
    ir = apply_params(make_multirotor(), {"payload.position_m": [0.04, 0.0, 0.0], "payload.mass_kg": 0.5})
    r = evaluate_l1_sync(ir, HOVER)
    assert r.metrics["cg_offset_m"] > 0.005
    assert r.status == "PASSED"  # 推力分配能补偿小重心偏移
    assert r.metrics["hover_throttle"] > evaluate_l1_sync(make_multirotor(), HOVER).metrics["hover_throttle"]


# ----------------------------- L2 -----------------------------------------
def test_l2_hover_is_stable_and_deterministic():
    ir = make_multirotor()
    a, b = evaluate_l2_sync(ir, WIND_DR), evaluate_l2_sync(ir, WIND_DR)
    assert a.status == "PASSED"
    assert a.metrics["tracking_rmse_m"] < 0.5 and a.metrics["max_tilt_deg"] < 10
    assert a.metrics["crash_rate"] == 0.0
    assert a.metrics == b.metrics  # 领域随机化种子由内容派生 → 可复现、可缓存


def test_l2_domain_randomization_is_reflected_in_worst_case_metrics():
    r = evaluate_l2_sync(make_multirotor(), WIND_DR)
    assert r.metrics["tracking_rmse_m_worst"] >= r.metrics["tracking_rmse_m"]


def test_l2_step_response_converges():
    sc = TestScenario(scenario_id="step", duration_s=12, sim_dt_s=0.005, mission=Mission(type="step_response"))
    r = evaluate_l2_sync(make_multirotor(), sc)
    assert r.status == "PASSED" and r.metrics["final_pos_err_m"] < 0.3


def test_l2_waypoints_mission_runs():
    sc = TestScenario(scenario_id="wp", duration_s=14, sim_dt_s=0.005, mission=Mission(
        type="waypoints", waypoints=[{"t_s": 0, "position_m": [0, 0, -5]}, {"t_s": 3, "position_m": [3, 0, -5]},
                                     {"t_s": 8, "position_m": [3, 3, -6]}]))
    assert evaluate_l2_sync(make_multirotor(), sc).status == "PASSED"


def test_rk4_exhibits_fourth_order_convergence_and_normalizes_replay():
    def integration_error(steps):
        y = np.array([1.0])
        for k in range(steps):
            y = _rk4_step(lambda t, state: -2 * state, k / steps, y, 1 / steps)
        return abs(y[0] - math.exp(-2))

    assert 12 < integration_error(8) / integration_error(16) < 20
    scenario = TestScenario(scenario_id="rk4", duration_s=8, sim_dt_s=0.01,
                            mission=Mission(type="step_response", step_m=(1, 0.3, -0.15)))
    ir = make_multirotor()
    coarse = evaluate_l2_sync(ir, scenario, record_every=1)
    fine = evaluate_l2_sync(ir, scenario.model_copy(update={"sim_dt_s": 0.005}))
    assert coarse.status == fine.status == "PASSED"
    assert coarse.metrics["tracking_rmse_m"] == pytest.approx(fine.metrics["tracking_rmse_m"], abs=0.01)
    np.testing.assert_allclose(np.linalg.norm(np.array(coarse.replay_frames)[:, 4:8], axis=1), 1, atol=2e-15, rtol=0)


def test_quintic_waypoint_reference_is_continuous_and_supplies_velocity():
    scenario = TestScenario(scenario_id="reference", duration_s=5, mission=Mission(type="waypoints", waypoints=[
        {"t_s": 2, "position_m": [2, 0, -5]}, {"t_s": 4, "position_m": [2, 3, -6]},
    ]))
    start, reference = _reference(scenario)
    np.testing.assert_array_equal(start, [0, 0, -5])
    pos, velocity = reference(1)
    np.testing.assert_allclose(pos, [1, 0, -5])
    np.testing.assert_allclose(velocity, [1.875, 0, 0])
    for t, expected in [(0, start), (2, [2, 0, -5]), (4, [2, 3, -6]), (5, [2, 3, -6])]:
        pos, velocity = reference(t)
        np.testing.assert_array_equal(pos, expected)
        np.testing.assert_array_equal(velocity, [0, 0, 0])
    h = 1e-5
    for t in (1, 2, 3):
        before, v_before = reference(t - h)
        after, v_after = reference(t + h)
        np.testing.assert_allclose((after - before) / (2*h), reference(t)[1], atol=1e-8)
        if t == 2:
            np.testing.assert_allclose((v_after - v_before) / (2*h), 0, atol=1e-4)


def test_lqr_rejects_a_gust_and_returns_to_hover():
    ir = make_multirotor().model_copy(update={"controller": Controller(type="lqr")}).finalize()
    gust = TestScenario(scenario_id="gust", duration_s=10, sim_dt_s=0.01, gust_start_s=0.5, gust_duration_s=2,
                        environment=Environment(wind=Wind(type="gust", velocity_m_s=(4, 0, 0))))
    np.testing.assert_allclose(_wind(gust, 1.5), [4, 0, 0])
    for t in (0.4, 0.5, 2.5, 3):
        np.testing.assert_allclose(_wind(gust, t), 0, atol=1e-14)
    legacy = HOVER.model_copy(update={"environment": gust.environment})
    np.testing.assert_allclose(_wind(legacy, 4), [4, 0, 0])
    result = evaluate_l2_sync(ir, gust)
    assert result.status == "PASSED"
    assert result.metrics["max_pos_err_m"] > 0.03
    assert result.metrics["final_pos_err_m"] < 0.02
    assert result.metrics["max_tilt_deg"] < 10


def test_mass_thrust_and_cg_randomization_apply_and_reproduce():
    ir = make_multirotor()
    sc = HOVER.model_copy(update={"duration_s": 4, "sim_dt_s": 0.01, "domain_randomization": DomainRandomization(
        enabled=True, trials=2, mass_variance_pct=8, thrust_variance_pct=7, cg_offset_variance_m=0.006,
    )})
    nominal, (mass, thrust, cg), _ = list(_trial_inputs(ir, sc, 43))
    assert nominal == (1.0, 1.0, (0.0, 0.0, 0.0))
    assert 0.92 <= mass <= 1.08 and mass != 1
    assert np.all((0.93 <= thrust) & (thrust <= 1.07)) and np.ptp(thrust) > 0
    assert np.all(np.abs(cg) <= 0.006) and np.linalg.norm(cg) > 0
    props_mass = mass_properties(_perturbed(ir, mass, np.zeros(3)))
    props_cg = mass_properties(_perturbed(ir, mass, cg))
    np.testing.assert_allclose(props_cg.cg - props_mass.cg, cg)
    reversed_ir = ir.model_copy(update={"rotors": ir.rotors[::-1]})
    np.testing.assert_array_equal(list(_trial_inputs(reversed_ir, sc, 43))[1][1], thrust[::-1])
    for kw in ({"mass_scale": mass}, {"thrust_scale": thrust}, {"cg_shift_m": cg}):
        assert simulate(ir, sc, **kw).metrics["tracking_rmse_m"] > 1e-4
    result = evaluate_l2_sync(ir, sc, seed=43, record_every=20)
    assert result.status == "PASSED"
    assert result.metrics == evaluate_l2_sync(ir, sc, seed=43).metrics
    assert result.metrics != evaluate_l2_sync(ir, sc, seed=44).metrics
    assert result.metrics["tracking_rmse_m_worst"] >= result.metrics["tracking_rmse_m"] > 0
    assert result.replay_frames == simulate(ir, sc, record_every=20).frames


def test_battery_sag_lowers_thrust_limit_under_load():
    assert battery_terminal_voltage(0) == PACK_OPEN_CIRCUIT_V
    assert battery_terminal_voltage(300) < battery_terminal_voltage(200) < PACK_OPEN_CIRCUIT_V
    barely_above_hover = make_multirotor(max_thrust_n=4.35)
    nominal = evaluate_l2_sync(make_multirotor(), HOVER)
    sagged = evaluate_l2_sync(barely_above_hover, HOVER)
    assert nominal.status == "PASSED" and nominal.metrics["min_battery_voltage_v"] < PACK_OPEN_CIRCUIT_V
    assert sagged.status == "CRASHED"
    assert sagged.metrics["saturation_frac"] == 1.0


def test_l2_underpowered_vehicle_crashes():
    r = evaluate_l2_sync(make_multirotor(max_thrust_n=3.0), HOVER)
    assert r.status == "CRASHED" and "crashed" in rules(r)


def test_l2_fault_tolerance_ordering_quad_hex_octo():
    fault = (FaultInjection(trigger_time_s=3.0, target_rotor_id="m1", fault_type="motor_out", severity=1.0),)
    sc = TestScenario(scenario_id="fault", duration_s=12, sim_dt_s=0.005, fault_injections=fault)
    quad = make_multirotor()
    hexa = make_multirotor(n_rotors=6, arm_length_m=0.35, max_thrust_n=10, base_mass_kg=1.5)
    octo = make_multirotor(n_rotors=8, arm_length_m=0.4, max_thrust_n=8, base_mass_kg=1.8)
    assert evaluate_l2_sync(quad, sc).status == "CRASHED"  # 四旋翼无冗余
    assert evaluate_l2_sync(hexa, sc).status == "PASSED"  # 六旋翼牺牲偏航后保持悬停
    assert evaluate_l2_sync(octo, sc).status == "PASSED"


def test_l2_partial_thrust_loss_is_survivable():
    f = (FaultInjection(trigger_time_s=3.0, target_rotor_id="m2", fault_type="thrust_loss", severity=0.4),)
    sc = TestScenario(scenario_id="loss", duration_s=10, sim_dt_s=0.005, fault_injections=f)
    assert evaluate_l2_sync(make_multirotor(), sc).status == "PASSED"


def test_l2_bad_inputs_are_contained():
    mpc = make_multirotor().model_copy(update={"controller": Controller(type="mpc")})
    assert "unsupported_controller" in rules(evaluate_l2_sync(mpc, HOVER))
    f = (FaultInjection(trigger_time_s=1.0, target_rotor_id="nope", fault_type="motor_out", severity=1.0),)
    r = evaluate_l2_sync(make_multirotor(), TestScenario(scenario_id="x", duration_s=3, fault_injections=f))
    assert r.status == "CRASHED" and "nope" in (r.error or "")


def test_l2_timeout_is_reported():
    r = evaluate_l2_sync(make_multirotor(), TestScenario(scenario_id="long", duration_s=600, sim_dt_s=0.002), timeout_s=0.2)
    assert r.status == "TIMEOUT"
