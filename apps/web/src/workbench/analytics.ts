import type { CandidateRecord, Violation } from '../contracts';
import { formatMetric, isMetricKey, METRIC_META } from './metricMeta';

export interface ViolationBucket {
  rule: string;
  label: string;
  count: number;
  ratio: number;
  sampleMessage: string;
}

const PHYSICAL_RULE_LABELS: Record<string, string> = {
  hover_thrust: '悬停推力不足',
  hover_infeasible: '无法稳定悬停',
  controllability_rank: '机身姿态无法充分控制',
  rotor_overlap: '桨盘相互干涉',
  rotor_clearance_m: '桨盘间距不足',
  battery_discharge_w: '电池放电功率不足',
  hover_power_exceeds_discharge: '悬停耗电超过电池上限',
  unsupported_controller: '飞控类型不支持',
  crashed: '飞行失稳',
};

const STOP_REASONS: Record<string, string> = {
  SEARCH_EXHAUSTED: '已评估本轮搜索计划中的候选方案',
  L1_BUDGET: '第 1 关的计算次数已达到预算上限',
  L2_BUDGET: '第 2 关的计算次数已达到预算上限',
  TIME_BUDGET: '实验运行时间已达到预算上限',
  USER_CANCELLED: '实验已由用户取消',
};

const eliminated = new Set<CandidateRecord['status']>(['REJECTED_CONSTRAINT', 'CRASHED', 'TIMEOUT', 'UNSUPPORTED']);
const metricFromRule = (rule: string) => rule.trim().split(/\s+/, 1)[0];

export function violationLabel(rule: string) {
  const key = metricFromRule(rule);
  if (isMetricKey(key)) return METRIC_META[key].label;
  return Object.hasOwn(PHYSICAL_RULE_LABELS, rule) ? PHYSICAL_RULE_LABELS[rule] : '其他评估规则';
}

export function formatViolationValues(violation: Violation) {
  const key = metricFromRule(violation.rule);
  const value = (number: number) => isMetricKey(key) ? formatMetric(key, number) : String(Number(number.toPrecision(6)));
  return `实际 ${value(violation.actual)}，阈值 ${value(violation.limit)}`;
}

export function aggregateViolations(candidates: readonly CandidateRecord[]): ViolationBucket[] {
  const buckets = new Map<string, ViolationBucket>();
  let total = 0;
  for (const candidate of candidates) {
    if (!eliminated.has(candidate.status)) continue;
    total += 1;
    const counted = new Set<string>();
    for (const violation of candidate.violations) {
      const { rule, message } = violation;
      if (counted.has(rule)) continue;
      counted.add(rule);
      const bucket = buckets.get(rule);
      if (bucket) bucket.count += 1;
      else buckets.set(rule, { rule, label: violationLabel(rule), count: 1, ratio: 0, sampleMessage: message || formatViolationValues(violation) });
    }
  }
  return [...buckets.values()]
    .map(bucket => ({ ...bucket, ratio: bucket.count / total }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule, 'en'));
}

export function summarizeCandidateStatuses(candidates: readonly CandidateRecord[]): Record<CandidateRecord['status'], number> {
  const counts = { NEW: 0, L1_PASSED: 0, PASSED: 0, REJECTED_CONSTRAINT: 0, CRASHED: 0, TIMEOUT: 0, UNSUPPORTED: 0, SKIPPED: 0 };
  for (const { status } of candidates) counts[status] += 1;
  return counts;
}

export function formatStopReason(reason: string | null): string {
  if (!reason) return '';
  return Object.hasOwn(STOP_REASONS, reason) ? STOP_REASONS[reason] : '实验已停止，详情见运行日志';
}

export function isInitialScreenRejection(candidate: CandidateRecord): boolean {
  // Both current second-stage evaluators emit tracking error on constraint rejection.
  return candidate.status === 'REJECTED_CONSTRAINT' && !Object.hasOwn(candidate.metrics, 'tracking_rmse_m')
    && !candidate.violations.some(violation => violation.rule === 'unsupported_controller');
}
