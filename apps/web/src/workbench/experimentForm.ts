import type { Budget, DroneIR, ExperimentRequest, SearchParameter, Waypoint } from '../contracts';

type BudgetKey = Exclude<keyof Budget, 'max_l3_evals'>;

export const BUDGET_FIELDS: { key: BudgetKey; label: string; min: number; max: number }[] = [
  { key: 'max_generations', label: '搜索代数', min: 1, max: 10000 },
  { key: 'batch_size', label: '每代候选数', min: 1, max: 100 },
  { key: 'max_l1_evals', label: '第 1 关计算预算', min: 1, max: 100000 },
  { key: 'max_l2_evals', label: '第 2 关计算预算', min: 0, max: 100000 },
  { key: 'timeout_sec', label: '总运行时限 / s', min: 1, max: 86400 },
];

export const BUDGET_PROFILES: { label: string; budget: Budget }[] = [
  { label: '快速探索', budget: { max_generations: 2, batch_size: 4, max_l1_evals: 8, max_l2_evals: 8, max_l3_evals: 0, timeout_sec: 60 } },
  { label: '标准对比', budget: { max_generations: 10, batch_size: 8, max_l1_evals: 100, max_l2_evals: 80, max_l3_evals: 0, timeout_sec: 300 } },
  { label: '深度寻优', budget: { max_generations: 20, batch_size: 12, max_l1_evals: 240, max_l2_evals: 200, max_l3_evals: 0, timeout_sec: 900 } },
];

// The generated contract uses a string here. These are the paths the current API accepts.
export const SEARCH_PARAMETERS: Record<string, { label: string; unit: string; bounds: SearchParameter['bounds'] }> = {
  'power.capacity_wh': { label: '电池容量', unit: 'Wh', bounds: [35, 130] },
  'rotors[*].max_thrust_n': { label: '单桨最大推力', unit: 'N', bounds: [3, 12] },
  'airframe.base_mass_kg': { label: '机身基础重量', unit: 'kg', bounds: [0.3, 0.9] },
  'rotors[*].arm_length_m': { label: '机臂长度', unit: 'm', bounds: [0.18, 0.35] },
  'rotors[*].prop_radius_m': { label: '桨半径', unit: 'm', bounds: [0.07, 0.15] },
  'rotors[*].motor_time_constant_s': { label: '电机时间常数', unit: 's', bounds: [0.02, 0.06] },
};

export const MAX_SEED = 2147483647;
export const asInputNumber = (value: number) => Number.isFinite(value) ? value : '';
const positive = (value: number) => Number.isFinite(value) && value > 0;
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const integerIn = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

export function validSearchBounds([low, high]: SearchParameter['bounds']) {
  return positive(low) && positive(high) && low < high;
}

export function waypointProblem(point: Waypoint, previous: Waypoint | undefined, duration: number) {
  if (!Number.isFinite(point.t_s) || point.t_s < 0 || point.t_s > duration) return '时间须在 0 到测试时长之间。';
  if (previous && point.t_s <= previous.t_s) return '时间须严格递增。';
  if (!point.position_m.every(Number.isFinite)) return '请填完整的北、东和高度坐标。';
  return '';
}

export function dynamicsStepLimit(request: ExperimentRequest, baseline: DroneIR | null) {
  const rotorTimes = (request.seed_ir ?? baseline)?.rotors.map(rotor => rotor.motor_time_constant_s) ?? [];
  const searchedTime = request.goal.search_space.find(parameter => parameter.param_path === 'rotors[*].motor_time_constant_s')?.bounds[0];
  if (searchedTime !== undefined && positive(searchedTime)) rotorTimes.push(searchedTime);
  return Math.min(0.01, ...rotorTimes.map(time => time / 2));
}

export function buildFormRequest(draft: ExperimentRequest, startPaused: boolean): ExperimentRequest {
  const request = structuredClone(draft);
  const { scenario } = request;
  const { mission, domain_randomization: randomization } = scenario;
  request.goal.name = request.goal.name.trim();
  request.start_paused = startPaused;
  // Keep inactive task edits in the draft and omit unused waypoints from the submitted mission.
  if (mission.type !== 'waypoints') mission.waypoints = [];
  if (mission.type !== 'step_response') {
    if (!mission.step_m.every(Number.isFinite)) mission.step_m = [1, 0, 0];
    if (!Number.isFinite(mission.step_time_s) || mission.step_time_s < 0) mission.step_time_s = 1;
  }
  if (scenario.wind_type === 'none' && !scenario.wind_velocity_m_s.every(Number.isFinite)) scenario.wind_velocity_m_s = [0, 0, 0];
  if (scenario.wind_type !== 'gust') {
    if (!nonnegative(scenario.gust_start_s)) scenario.gust_start_s = 2;
    if (!positive(scenario.gust_duration_s)) scenario.gust_duration_s = 4;
  }
  if (!randomization.enabled) {
    if (!integerIn(randomization.trials, 1, 20)) randomization.trials = 2;
    if (!Number.isFinite(randomization.mass_variance_pct) || randomization.mass_variance_pct < 0 || randomization.mass_variance_pct > 50) {
      randomization.mass_variance_pct = 10;
    }
    if (!nonnegative(randomization.thrust_variance_pct) || randomization.thrust_variance_pct >= 100) randomization.thrust_variance_pct = 0;
    if (!nonnegative(randomization.cg_offset_variance_m)) randomization.cg_offset_variance_m = 0;
  }
  for (const fault of scenario.fault_injections) {
    if (fault.fault_type === 'motor_out') fault.severity = 1;
  }
  return request;
}

export type FormIssue = { section: 'basic' | 'advanced' | 'search'; message: string };

export function validateFormRequest(request: ExperimentRequest, baseline: DroneIR | null, awaitingHistoricalSeed: boolean): FormIssue | null {
  const { goal, scenario } = request;
  const { mission, duration_s: duration, sim_dt_s: step, domain_randomization: randomization } = scenario;
  const aircraft = request.seed_ir ?? baseline;
  if (!goal.name || [...goal.name].length > 100) return { section: 'basic', message: '实验名称须为 1–100 个字符。' };
  if (awaitingHistoricalSeed) return { section: 'basic', message: '请选择要用作参考机型的历史优选方案。' };
  if (!positive(mission.altitude_m)) return { section: 'basic', message: '悬停或起始高度须大于 0。' };
  if (!positive(duration) || duration > 600) return { section: 'advanced', message: '测试时长须大于 0 且不超过 600 秒。' };
  if (mission.type === 'step_response' && (!mission.step_m.every(Number.isFinite) || !Number.isFinite(mission.step_time_s)
    || mission.step_time_s < 0 || mission.step_time_s >= duration)) {
    return { section: 'basic', message: '请填完整的三轴突跃位移。触发时刻须大于等于 0 且早于测试结束。' };
  }
  if (mission.type === 'waypoints') {
    if (!mission.waypoints.length) return { section: 'basic', message: '多点巡航至少需要一个航点。' };
    for (const [index, point] of mission.waypoints.entries()) {
      const problem = waypointProblem(point, mission.waypoints[index - 1], duration);
      if (problem) return { section: 'basic', message: `航点 ${index + 1}：${problem}` };
    }
  }
  if (!positive(step) || step > duration || duration / step > 200000) {
    return { section: 'advanced', message: '仿真步长须大于 0 且不超过测试时长，积分步数最多 200,000。' };
  }
  if (!positive(scenario.air_density_kg_m3) || !scenario.wind_velocity_m_s.every(Number.isFinite)) {
    return { section: 'advanced', message: '请填写完整的三轴风速和大于 0 的空气密度。' };
  }
  if (scenario.wind_type === 'gust' && (!nonnegative(scenario.gust_start_s) || !positive(scenario.gust_duration_s))) {
    return { section: 'advanced', message: '阵风开始时间须大于等于 0，持续时间须大于 0。' };
  }
  const rotorIds = new Set(aircraft?.rotors.map(rotor => rotor.id));
  for (const [index, fault] of scenario.fault_injections.entries()) {
    if (!Number.isFinite(fault.trigger_time_s) || fault.trigger_time_s < 0 || fault.trigger_time_s >= duration) {
      return { section: 'advanced', message: `故障 ${index + 1} 的触发时刻须大于等于 0 且早于测试结束。` };
    }
    if (!rotorIds.has(fault.target_rotor_id)) return { section: 'advanced', message: `请为故障 ${index + 1} 选择当前参考机型中的旋翼。` };
    if (!positive(fault.severity) || fault.severity > 1) return { section: 'advanced', message: `请填写故障 ${index + 1} 的有效推力衰减比例。` };
  }
  if (randomization.enabled && (!integerIn(randomization.trials, 1, 20) || !Number.isFinite(randomization.mass_variance_pct)
    || randomization.mass_variance_pct < 0 || randomization.mass_variance_pct > 50)) {
    return { section: 'advanced', message: '随机试验次数须为 1–20 的整数，重量波动须在 0%–50% 之间。' };
  }
  if (randomization.enabled && (!nonnegative(randomization.thrust_variance_pct) || randomization.thrust_variance_pct >= 100
    || !nonnegative(randomization.cg_offset_variance_m))) {
    return { section: 'advanced', message: '推力波动须大于等于 0% 且小于 100%，质心偏移须大于等于 0。' };
  }
  if (!goal.objectives.length || goal.objectives.some(objective => !positive(objective.weight))) {
    return { section: 'advanced', message: '至少保留一个优化目标，每项目标的权重须大于 0。' };
  }
  if (goal.constraints.some(constraint => !Number.isFinite(constraint.limit))) {
    return { section: 'advanced', message: '请给每条约束填写限值。' };
  }
  for (const parameter of goal.search_space) {
    if (!validSearchBounds(parameter.bounds)) {
      return { section: 'search', message: `${SEARCH_PARAMETERS[parameter.param_path]?.label ?? '搜索参数'}的下界和上界须大于 0，且下界须小于上界。` };
    }
  }
  if (request.evaluation_mode === 'dynamics') {
    const limit = dynamicsStepLimit(request, baseline);
    if (step > limit) return { section: 'advanced', message: `当前参考机型和搜索范围允许的最大仿真步长为 ${limit} 秒。` };
    if (aircraft?.rotors.some(rotor => rotor.thrust_axis[0] !== 0 || rotor.thrust_axis[1] !== 0 || rotor.thrust_axis[2] !== -1)) {
      return { section: 'basic', message: '三维飞行模拟需要使用竖直推力旋翼，请选择兼容的参考机型。' };
    }
    const gainNames = aircraft?.controller.type === 'cascaded_pid' ? ['rate_kr', 'rate_kp', 'att_kp', 'pos_kp', 'pos_kd', 'pos_ki'] : [];
    if (aircraft && Object.keys(aircraft.controller.params).some(key => !gainNames.includes(key))) {
      return { section: 'basic', message: '参考机型包含当前三维飞行模拟不支持的飞控参数。' };
    }
  }
  if (!integerIn(request.seed, 0, MAX_SEED)) return { section: 'advanced', message: `随机种子须为 0–${MAX_SEED} 的整数。` };
  const invalidBudget = BUDGET_FIELDS.find(field => !integerIn(goal.budget[field.key], field.min, field.max));
  if (invalidBudget) return { section: 'advanced', message: `${invalidBudget.label}须为 ${invalidBudget.min}–${invalidBudget.max} 的整数。` };
  return null;
}
