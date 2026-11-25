import { createContext, useCallback, useContext, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { api, ApiError, type Candidate, type Run, type RunSummary } from '../api';
import type { DroneIR, HealthStatus, PresetSpec } from '../contracts';

export type CameraPreset = 'iso' | 'top' | 'side';
export type WorkbenchStage = 'monitor' | 'compare' | 'studio';
export interface ModelCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  preset: CameraPreset;
  reset: number;
}
interface State {
  activeStage: WorkbenchStage;
  studioMode: 'edit' | 'replay';
  compareIds: string[];
  presets: PresetSpec[] | null;
  health: HealthStatus | null;
  selected: Candidate | null;
  hovered: string | null;
  detailId: string | null;
  onlyPareto: boolean;
  explode: number;
  spinning: boolean;
  activePart: string | null;
  camera: CameraPreset;
  cameraReset: number;
  draft: DroneIR | null;
  dirty: boolean;
}
const initial: State = { activeStage: 'monitor', studioMode: 'edit', compareIds: [], presets: null, health: null, selected: null, hovered: null, detailId: null, onlyPareto: false, explode: 0, spinning: false, activePart: null, camera: 'iso', cameraReset: 0, draft: null, dirty: false };
interface Workbench {
  state: State;
  modelCamera: MutableRefObject<ModelCameraPose | null>;
  presetsError: string;
  reloadPresets: () => void;
  patch: (value: Partial<State>) => void;
  setActiveStage: (stage: WorkbenchStage) => void;
  toggleCompareId: (id: string) => void;
  select: (candidate: Candidate, detail?: boolean) => boolean;
  edit: (updater: (ir: DroneIR) => void) => void;
  resetDraft: () => void;
  clear: () => void;
  canLeave: () => boolean;
}
const Context = createContext<Workbench | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initial);
  const modelCamera = useRef<ModelCameraPose | null>(null);
  const [loadPresets, setLoadPresets] = useState(0);
  const [presetsError, setPresetsError] = useState('');
  const patch = useCallback((value: Partial<State>) => setState(s => ({ ...s, ...value })), []);
  const reloadPresets = useCallback(() => { setPresetsError(''); setLoadPresets(value => value + 1); }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<PresetSpec[]>('/presets', { signal: controller.signal })
      .then(presets => { if (!controller.signal.aborted) patch({ presets }); })
      .catch(error => { if (!controller.signal.aborted) setPresetsError(error.message); });
    return () => controller.abort();
  }, [loadPresets, patch]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const health = await api<HealthStatus>('/health', { signal: controller.signal });
        if (!controller.signal.aborted) patch({ health });
      } catch {
        if (!controller.signal.aborted) patch({ health: null });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [patch]);

  const setActiveStage = useCallback((activeStage: WorkbenchStage) => patch({ activeStage }), [patch]);
  const toggleCompareId = useCallback((id: string) => setState(s => {
    if (s.compareIds.includes(id)) return { ...s, compareIds: s.compareIds.filter(value => value !== id) };
    if (s.compareIds.length === 3) return s;
    return { ...s, compareIds: [...s.compareIds, id] };
  }), []);
  const canLeave = useCallback(() => !state.dirty || window.confirm('当前参数草稿尚未提交，是否放弃这些修改？'), [state.dirty]);
  const select = useCallback((candidate: Candidate, detail = false) => {
    if (state.selected?.candidate_id !== candidate.candidate_id && !canLeave()) return false;
    setState(s => s.selected?.candidate_id === candidate.candidate_id
      ? { ...s, detailId: detail ? candidate.candidate_id : s.detailId }
      : { ...s, selected: candidate, draft: structuredClone(candidate.ir), dirty: false, activePart: null, detailId: detail ? candidate.candidate_id : null });
    return true;
  }, [state.selected?.candidate_id, canLeave]);
  const edit = useCallback((updater: (ir: DroneIR) => void) => setState(s => {
    if (!s.selected) return s;
    const draft = structuredClone(s.draft ?? s.selected.ir);
    updater(draft);
    return { ...s, draft, dirty: JSON.stringify(draft) !== JSON.stringify(s.selected.ir) };
  }), []);
  const resetDraft = useCallback(() => setState(s => ({ ...s, draft: s.selected ? structuredClone(s.selected.ir) : null, dirty: false })), []);
  const clear = useCallback(() => {
    modelCamera.current = null;
    setState(s => ({ ...initial, presets: s.presets, health: s.health }));
  }, []);
  return <Context.Provider value={{ state, modelCamera, presetsError, reloadPresets, patch, setActiveStage, toggleCompareId, select, edit, resetDraft, clear, canLeave }}>{children}</Context.Provider>;
}

export function useWorkbenchStore() {
  const context = useContext(Context);
  if (!context) throw new Error('WorkbenchProvider is required');
  return context;
}

type Transport = 'connecting' | 'sse' | 'poll' | 'settled';

export function isRunning(status: RunSummary['status']) {
  return status === 'RUNNING' || status === 'QUEUED';
}

function pollDelay(run: Run | null) {
  const revisionPending = run?.candidates.some(candidate => candidate.source === 'manual_revision'
    && (candidate.status === 'NEW' || candidate.status === 'L1_PASSED'));
  return !run || isRunning(run.status) || revisionPending ? 1000 : 5000;
}

const cursor = (run: Run) => run.events.at(-1)?.seq ?? 0;

export function useRunFeed(runId: string | null, onMissing: (id: string) => void) {
  const [snapshot, setSnapshot] = useState<Run | null>(null);
  const [stream, setStream] = useState<{ id: string; mode: Transport } | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const notify = useRef<(() => void) | null>(null);
  const rememberRun = useCallback((next: Run) => setSnapshot(current => {
    if (current?.id === next.id && (current.updated_at > next.updated_at || cursor(current) > cursor(next))) return current;
    return next;
  }), []);
  const rememberName = useCallback((summary: RunSummary) => setSnapshot(current => {
    if (current?.id !== summary.id || current.updated_at > summary.updated_at) return current;
    return { ...current, name: summary.name, updated_at: summary.updated_at,
      request: { ...current.request, goal: { ...current.request.goal, name: summary.name } } };
  }), []);
  const addRevision = useCallback((revision: Candidate) => {
    setSnapshot(current => current?.id === revision.run_id && !current.candidates.some(c => c.candidate_id === revision.candidate_id)
      ? { ...current, candidates: [...current.candidates, revision] } : current);
    setConnectionVersion(version => version + 1);
  }, []);

  useEffect(() => {
    if (!runId) return;
    const id = runId;
    const path = `/experiments/${encodeURIComponent(id)}`;
    const controller = new AbortController();
    let source: EventSource | undefined;
    let latest: Run | null = null;
    let mode: Transport = typeof EventSource === 'undefined' ? 'poll' : 'connecting';
    let streamFinished = false;
    let inFlight = false;
    let dirty = false;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    function setMode(value: Transport) {
      mode = value;
      setStream(current => current?.id === id && current.mode === mode ? current : { id, mode });
    }
    function schedulePoll() {
      clearTimeout(pollTimer);
      if (mode === 'sse' || controller.signal.aborted) return;
      const delay = pollDelay(latest);
      if (delay === 5000 && document.hidden) return;
      pollTimer = setTimeout(() => void reload(), delay);
    }
    function invalidate() {
      if (controller.signal.aborted) return;
      clearTimeout(pollTimer);
      if (inFlight) { dirty = true; return; }
      if (syncTimer !== undefined) return;
      // One evaluation can produce both a summary update and several log events.
      syncTimer = setTimeout(() => { syncTimer = undefined; void reload(); }, 80);
    }
    function connect(after: number) {
      try { source = new EventSource(`/api${path}/stream?after_seq=${after}`); }
      catch { streamFinished = true; setMode('poll'); return; }
      source.onopen = () => {
        if (controller.signal.aborted) return;
        setMode('sse');
        invalidate();
      };
      source.onerror = () => {
        if (controller.signal.aborted || streamFinished) return;
        // Let EventSource resume transient failures with its Last-Event-ID header.
        setMode('poll');
        schedulePoll();
      };
      source.addEventListener('update', invalidate);
      source.addEventListener('event', invalidate);
      source.addEventListener('done', () => {
        if (controller.signal.aborted) return;
        streamFinished = true;
        source?.close();
        setMode('settled');
        invalidate();
      });
    }
    async function reload() {
      if (controller.signal.aborted) return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      try {
        const next = await api<Run>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        latest = next;
        rememberRun(next);
        setError(null);
        if (!source && !streamFinished && typeof EventSource !== 'undefined') connect(cursor(next));
        else if (source && !streamFinished && source.readyState === EventSource.OPEN) setMode('sse');
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) {
          source?.close();
          controller.abort();
          onMissing(id);
        } else {
          setError({ id, message: (err as Error).message });
          setMode('poll');
        }
      } finally {
        inFlight = false;
        if (dirty) { dirty = false; invalidate(); }
        else schedulePoll();
      }
    }
    function resumeVisible() {
      if (!document.hidden && mode !== 'sse') invalidate();
    }

    setMode(mode);
    notify.current = invalidate;
    document.addEventListener('visibilitychange', resumeVisible);
    void reload();
    return () => {
      controller.abort();
      source?.close();
      notify.current = null;
      clearTimeout(syncTimer);
      clearTimeout(pollTimer);
      document.removeEventListener('visibilitychange', resumeVisible);
    };
  }, [runId, connectionVersion, onMissing, rememberRun]);

  return {
    run: snapshot?.id === runId ? snapshot : null,
    transport: stream?.id === runId ? stream?.mode : 'connecting',
    feedError: error?.id === runId ? error?.message : '',
    rememberRun, rememberName, addRevision,
    refresh: () => notify.current?.(),
  };
}
