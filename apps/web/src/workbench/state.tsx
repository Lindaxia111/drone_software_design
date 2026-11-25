import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Candidate } from '../api';
import type { DroneIR } from '../contracts';

export type CameraPreset = 'iso' | 'top' | 'side';
interface State {
  selected: Candidate | null;
  hovered: string | null;
  paretoOpen: boolean;
  detailId: string | null;
  studioOpen: boolean;
  onlyPareto: boolean;
  explode: number;
  spinning: boolean;
  activePart: string | null;
  camera: CameraPreset;
  cameraReset: number;
  draft: DroneIR | null;
  dirty: boolean;
}
const initial: State = { selected: null, hovered: null, paretoOpen: false, detailId: null, studioOpen: false, onlyPareto: false, explode: 0, spinning: false, activePart: null, camera: 'iso', cameraReset: 0, draft: null, dirty: false };
interface Workbench {
  state: State;
  patch: (value: Partial<State>) => void;
  select: (candidate: Candidate, detail?: boolean) => boolean;
  edit: (updater: (ir: DroneIR) => void) => void;
  resetDraft: () => void;
  clear: () => void;
  canLeave: () => boolean;
}
const Context = createContext<Workbench | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initial);
  const patch = useCallback((value: Partial<State>) => setState(s => ({ ...s, ...value })), []);
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
  const clear = useCallback(() => setState({ ...initial }), []);
  return <Context.Provider value={{ state, patch, select, edit, resetDraft, clear, canLeave }}>{children}</Context.Provider>;
}

export function useWorkbenchStore() {
  const context = useContext(Context);
  if (!context) throw new Error('WorkbenchProvider is required');
  return context;
}
