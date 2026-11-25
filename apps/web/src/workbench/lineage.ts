import type { CandidateRecord } from '../contracts';
import { formatMetric } from './metricMeta';

export const LINEAGE_METRICS = [
  { metric: 'flight_time_min', delta: 'deltaFlightMin' },
  { metric: 'tracking_rmse_m', delta: 'deltaRmseM' },
  { metric: 'total_mass_kg', delta: 'deltaMassKg' },
] as const;
type LineageMetric = typeof LINEAGE_METRICS[number]['metric'];

export interface LineageDiff {
  parentId: string;
  parentIndex: number;
  deltaFlightMin: number | null;
  deltaRmseM: number | null;
  deltaMassKg: number | null;
}

export function buildLineage(candidates: readonly CandidateRecord[]) {
  const previous = new Map<string, CandidateRecord>();
  const lineage = new Map<string, LineageDiff>();
  for (const candidate of [...candidates].sort((a, b) => a.proposal_index - b.proposal_index)) {
    const { run_id, ir_hash, parent_ir_hash } = candidate;
    if (candidate.source === 'manual_revision' && parent_ir_hash) {
      // Older records identify the parent by hash. Prefer the closest earlier matching candidate in the run.
      const parent = previous.get(`${run_id}:${parent_ir_hash}`);
      if (parent && parent.proposal_index < candidate.proposal_index) {
        const difference = (metric: LineageMetric) => {
          const childValue = candidate.metrics[metric], parentValue = parent.metrics[metric];
          return Number.isFinite(childValue) && Number.isFinite(parentValue) ? childValue - parentValue : null;
        };
        lineage.set(candidate.candidate_id, {
          parentId: parent.candidate_id, parentIndex: parent.proposal_index,
          deltaFlightMin: difference('flight_time_min'), deltaRmseM: difference('tracking_rmse_m'), deltaMassKg: difference('total_mass_kg'),
        });
      }
    }
    previous.set(`${run_id}:${ir_hash}`, candidate);
  }
  return lineage;
}

export function formatLineageDelta(metric: LineageMetric, delta: number) {
  const magnitude = formatMetric(metric, Math.abs(delta));
  return `${delta === 0 ? '' : delta < 0 ? '−' : '+'}${magnitude}`;
}
