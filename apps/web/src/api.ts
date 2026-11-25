export type { CandidateRecord as Candidate, CandidateDetails, ExperimentRequest, ExperimentRun as Run, RunSummary } from './contracts';
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: {'Content-Type': 'application/json', ...options.headers} });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((v: {msg: string}) => v.msg).join('；') : `请求失败 (${response.status})`);
  }
  return response.json();
}
