export type { CandidateRecord as Candidate, CandidateDetails, ExperimentRequest, ExperimentRun as Run, RunSummary } from './contracts';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: {'Content-Type': 'application/json', ...options.headers} });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload.detail;
    throw new ApiError(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((v: {msg: string}) => v.msg).join('；') : `请求失败 (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
