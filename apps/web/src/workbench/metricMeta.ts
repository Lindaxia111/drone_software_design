import type { Constraint, Objective } from '../contracts';

export type MetricKey = Constraint['metric'] | Objective['metric'];

interface MetricMeta {
  label: string;
  techName: string;
  unit: string;
  direction: Objective['direction'];
  description: string;
  precision: number;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  total_mass_kg: { label: '整机总重量', techName: 'Total Mass', unit: 'kg', direction: 'minimize', description: '机身、电池和载荷加起来有多重。', precision: 3 },
  thrust_to_weight_ratio: { label: '动力余量（推重比）', techName: 'Thrust-to-Weight Ratio', unit: '', direction: 'maximize', description: '最大总推力是整机重力的几倍，倍数越高，通常越有余力抗风。', precision: 2 },
  flight_time_min: { label: '理论悬停续航', techName: 'Analytic Flight Time', unit: 'min', direction: 'maximize', description: '用悬停时的耗电量估算能飞多久。', precision: 2 },
  flight_time_min_sim: { label: '模拟飞行续航', techName: 'Simulated Flight Time', unit: 'min', direction: 'maximize', description: '把模拟任务中的转向、加速和抗风耗电算进去后估算的续航。', precision: 2 },
  hover_power_w: { label: '悬停耗电功率', techName: 'Hover Power', unit: 'W', direction: 'minimize', description: '无人机停在空中时需要多少电功率。', precision: 1 },
  tracking_rmse_m: { label: '平均航迹偏差', techName: 'Tracking RMSE', unit: 'm', direction: 'minimize', description: '衡量全程偏离目标路线的程度，较大的偏差影响更大。', precision: 3 },
  max_pos_err_m: { label: '最大瞬时偏离', techName: 'Max Position Error', unit: 'm', direction: 'minimize', description: '整段飞行中偏离目标最远的一刻有多远。', precision: 3 },
  final_pos_err_m: { label: '终点停靠偏差', techName: 'Final Position Error', unit: 'm', direction: 'minimize', description: '任务结束时距离目标停靠点还有多远。', precision: 3 },
  max_tilt_deg: { label: '最大机身倾角', techName: 'Max Tilt Angle', unit: '°', direction: 'minimize', description: '整段飞行中机身倾斜最厉害时的角度。', precision: 1 },
  saturation_frac: { label: '电机满载占比', techName: 'Actuator Saturation', unit: '0–1', direction: 'minimize', description: '电机已达到推力上限、没有余力再加力的时间占比。', precision: 1 },
  crash_rate: { label: '失稳坠机率', techName: 'Crash Rate', unit: '0–1', direction: 'minimize', description: '重复模拟中发生失稳坠机的比例。', precision: 1 },
};

export function isMetricKey(key: string): key is MetricKey {
  return Object.hasOwn(METRIC_META, key);
}

export function formatMetric(key: MetricKey, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const { unit, precision } = METRIC_META[key];
  if (unit === '0–1') return `${(value * 100).toFixed(precision)}%`;
  return `${value.toFixed(precision)}${unit ? ` ${unit}` : ''}`;
}
