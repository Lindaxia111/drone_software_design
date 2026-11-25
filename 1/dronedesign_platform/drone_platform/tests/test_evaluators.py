import time

import pytest

from dronedesign.evaluators import evaluate_l1_sync, evaluate_l2_sync
from dronedesign.irtools import apply_params, make_multirotor
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
    lqr = make_multirotor().model_copy(update={"controller": Controller(type="lqr")})
    assert "unsupported_controller" in rules(evaluate_l2_sync(lqr, HOVER))
    f = (FaultInjection(trigger_time_s=1.0, target_rotor_id="nope", fault_type="motor_out", severity=1.0),)
    r = evaluate_l2_sync(make_multirotor(), TestScenario(scenario_id="x", duration_s=3, fault_injections=f))
    assert r.status == "CRASHED" and "nope" in (r.error or "")


def test_l2_timeout_is_reported():
    r = evaluate_l2_sync(make_multirotor(), TestScenario(scenario_id="long", duration_s=600, sim_dt_s=0.002), timeout_s=0.2)
    assert r.status == "TIMEOUT"
