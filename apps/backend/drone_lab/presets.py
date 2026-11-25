"""Validated starter experiments shared by the onboarding and configuration views."""

from .domain import Budget, DesignGoal, ExperimentRequest, Mission, PresetSpec, TestScenario, Waypoint


def _preset(title, summary, difficulty, estimated_sec, scenario, batch_size):
    return PresetSpec(
        id=scenario.scenario_id,
        title=title,
        summary=summary,
        difficulty=difficulty,
        estimated_sec=estimated_sec,
        request=ExperimentRequest(
            goal=DesignGoal(name=title, budget=Budget(
                max_generations=1, batch_size=batch_size, max_l1_evals=batch_size, max_l2_evals=batch_size,
            )),
            scenario=scenario,
            evaluation_mode="dynamics",
            optimizer="evolution",
        ),
    )


PRESETS = (
    _preset("抗风悬停入门", "观察无人机在恒定侧风中能否稳住位置。", "starter", 5,
            TestScenario(scenario_id="wind_hover_starter", duration_s=4, sim_dt_s=0.01,
                         wind_velocity_m_s=(0, 2, 0)), 4),
    _preset("定点突跃敏捷测试", "用一次三轴位移指令比较响应速度和停靠精度。", "intermediate", 10,
            TestScenario(scenario_id="step_agility", duration_s=6, sim_dt_s=0.01, wind_type="none",
                         mission=Mission(type="step_response", step_m=(1.0, 0.5, -0.3), step_time_s=1.5)), 6),
    _preset("多点巡航路线", "跟随指定航点飞行并回到起点，比较航迹偏差。", "intermediate", 15,
            TestScenario(scenario_id="waypoint_patrol", duration_s=9, sim_dt_s=0.01, wind_type="none",
                         mission=Mission(type="waypoints", waypoints=[
                             Waypoint(t_s=0, position_m=(0, 0, -5)),
                             Waypoint(t_s=2, position_m=(2, 0, -5)),
                             Waypoint(t_s=4, position_m=(2, 2, -5)),
                             Waypoint(t_s=7, position_m=(0, 0, -5)),
                         ])), 6),
    _preset("单桨故障容错测试", "模拟一只旋翼推力下降，观察飞行能否恢复稳定。", "advanced", 15,
            TestScenario(scenario_id="rotor_fault_tolerance", duration_s=8, sim_dt_s=0.01, wind_type="none",
                         fault_injections=[{"trigger_time_s": 2, "target_rotor_id": "r1",
                                            "fault_type": "thrust_loss", "severity": 0.5}]), 6),
)
