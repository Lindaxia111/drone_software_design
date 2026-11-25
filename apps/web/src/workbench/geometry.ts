import type { DroneIR, ExperimentRequest } from '../contracts';

export function frdToScene(v: readonly number[]): [number, number, number] {
  return [v[1], -v[2], -v[0]];
}
export function armLength(ir: DroneIR) {
  return ir.rotors.reduce((sum, rotor) => sum + Math.hypot(...rotor.position_m.slice(0, 2)), 0) / ir.rotors.length;
}
export function inspectIR(ir: DroneIR, request?: ExperimentRequest) {
  const mass = ir.airframe.base_mass_kg + ir.power.battery_mass_kg + ir.payload.mass_kg;
  const lift = ir.rotors.reduce((sum, r) => sum + r.max_thrust_n * -r.thrust_axis[2], 0);
  const thrustRatio = lift / Math.max(mass * 9.80665, 0.0001);
  const conflicts = new Set<string>();
  const warnings: string[] = [], errors: string[] = [];
  ir.rotors.forEach((a, i) => ir.rotors.slice(i + 1).forEach(b => {
    const distance = Math.hypot(...a.position_m.map((v, axis) => v - b.position_m[axis]));
    if (distance < a.prop_radius_m + b.prop_radius_m) { conflicts.add(a.id); conflicts.add(b.id); }
  }));
  const positive = [ir.airframe.base_mass_kg, ...ir.airframe.inertia_diag_kg_m2, ir.power.capacity_wh, ir.power.battery_mass_kg, ir.power.max_discharge_w,
    ...ir.rotors.flatMap(r => [r.max_thrust_n, r.prop_radius_m, r.motor_time_constant_s, r.torque_to_thrust_ratio])];
  if (positive.some(v => !Number.isFinite(v) || v <= 0) || ir.payload.mass_kg < 0) errors.push('质量、尺寸、推力、惯量和时间常数必须有效且为正；载荷可为零。');
  if (ir.rotors.some(r => Math.abs(Math.hypot(...r.thrust_axis) - 1) > 1e-6)) errors.push('旋翼推力轴必须归一化。');
  if (Object.values(ir.controller.params).some(v => !Number.isFinite(v))) errors.push('控制器增益必须为有限数值。');
  if (request?.evaluation_mode === 'dynamics') {
    if (ir.rotors.some(r => r.thrust_axis.some((v, i) => Math.abs(v - [0, 0, -1][i]) > 1e-9))) errors.push('当前动力学控制器仅接受竖直推力轴；倾转构型可预览和导出。');
    if (ir.rotors.some(r => request.scenario.sim_dt_s > r.motor_time_constant_s / 2)) errors.push('当前场景步长超过电机时间常数的一半，请增大时间常数或新建场景。');
  }
  if (conflicts.size) warnings.push(`桨盘包络干涉：${[...conflicts].join('、')}，L1 将进一步筛选。`);
  if (thrustRatio < 1) warnings.push('推重比小于 1，可能无法悬停。');
  const cg = [0, 1, 2].map(i => (ir.airframe.base_mass_kg * ir.airframe.cg_offset_m[i] + ir.payload.mass_kg * ir.payload.position_m[i]) / Math.max(mass, 0.0001));
  return { mass, thrustRatio, hover: 1 / Math.max(thrustRatio, 0.0001), conflicts, warnings, errors, cg };
}

export function downloadIR(ir: DroneIR, name = 'revised-drone') {
  const blob = new Blob([JSON.stringify(ir, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = href; anchor.download = `${name}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export function flattenIR(value: unknown, prefix = ''): Record<string, string> {
  if (Array.isArray(value)) return Object.assign({}, ...value.map((v, i) => flattenIR(v, `${prefix}[${i}]`)));
  if (value && typeof value === 'object') return Object.assign({}, ...Object.entries(value).map(([k, v]) => flattenIR(v, prefix ? `${prefix}.${k}` : k)));
  return { [prefix]: typeof value === 'number' ? Number(value.toPrecision(7)).toString() : String(value) };
}
