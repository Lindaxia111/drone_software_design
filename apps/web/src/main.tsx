import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Box, CircleHelp, Eraser, FlaskConical, Layers3, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api, ApiError, type Candidate, type ExperimentRequest, type Run, type RunSummary } from './api';
import { CreateDialog } from './components/CreateDialog';
import { CandidateDialog, ExperimentDialog } from './components/DetailsDialog';
import { EmptyOnboarding } from './components/EmptyOnboarding';
import { StepperHeader, type RunAction } from './components/StepperHeader';
import { TermTooltip } from './components/TermTooltip';
import type { CachePruneRequest, CachePruneResult, DroneIR, RenameRunRequest } from './contracts';
import { GLOSSARY, OPTIMIZER_TERMS } from './workbench/glossary';
import { buildLineage } from './workbench/lineage';
import { ParetoDrawer } from './workbench/ParetoDrawer';
import { isRunning, useRunFeed, WorkbenchProvider, useWorkbenchStore } from './workbench/state';
import { Studio } from './workbench/Studio';
import { Status, statusNames, WorkbenchMonitor } from './workbench/WorkbenchMonitor';
import './style.css';
import './workbench/workbench.css';

const date = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const runPath = (id: string) => `/experiments/${encodeURIComponent(id)}`;
const cachePruneRequest: CachePruneRequest = { max_entries: 2000, max_age_days: 30 };

function RenameDialog({ target, onSave, onClose }: {
  target: RunSummary;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(target.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} aria-labelledby="rename-heading" onCancel={event => {
    event.preventDefault();
    if (!saving) onClose();
  }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (!name.trim() || saving) return;
      setSaving(true);
      setError('');
      try { await onSave(name.trim()); }
      catch (err) { setError((err as Error).message); }
      finally { setSaving(false); }
    }}>
      <div className="dialog-heading"><h2 id="rename-heading">重命名实验</h2></div>
      <label>实验名称<input autoFocus value={name} maxLength={100} required disabled={saving} onChange={event => setName(event.target.value)}/></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer">
        <button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button>
        <button type="submit" className="button primary" disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存名称'}</button>
      </div>
    </form>
  </dialog>;
}

function App() {
  const { state, patch, clear, canLeave, setActiveStage, presetsError, reloadPresets } = useWorkbenchStore();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<ExperimentRequest | null>(null);
  const [baselineIr, setBaselineIr] = useState<DroneIR | null>(null);
  const [createRequest, setCreateRequest] = useState<ExperimentRequest | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RunSummary | null>(null);
  const [revisionNotice, setRevisionNotice] = useState('');
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pruningCache, setPruningCache] = useState(false);
  const [cachePruneResult, setCachePruneResult] = useState<CachePruneResult | null>(null);
  const listRevision = useRef(0);

  const removeRun = useCallback((id: string) => {
    listRevision.current += 1;
    setRuns(current => current?.filter(item => item.id !== id) ?? []);
    setSelected(current => current === id ? null : current);
  }, []);
  const { run, transport, feedError, rememberRun, rememberName, addRevision, refresh } = useRunFeed(selected, removeRun);

  useEffect(() => {
    const controller = new AbortController();
    api<{ request: ExperimentRequest; baseline_ir: DroneIR }>('/defaults', { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        setDefaults(value.request);
        setBaselineIr(value.baseline_ir);
      })
      .catch(err => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function loadList() {
      const revision = listRevision.current;
      try {
        const list = await api<RunSummary[]>('/experiments?limit=100', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (revision === listRevision.current) setRuns(list);
        setListError('');
        setOnline(true);
      } catch (err) {
        if (!controller.signal.aborted) { setOnline(false); setListError((err as Error).message); }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(loadList, 5000);
      }
    }
    void loadList();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  useEffect(() => { setSelected(previous => previous ?? runs?.[0]?.id ?? null); }, [runs]);
  useEffect(() => { clear(); setShowConfig(false); setRevisionNotice(''); }, [selected, clear]);
  useEffect(() => { if (state.activeStage !== 'monitor') window.scrollTo(0, 0); }, [state.activeStage]);

  const candidate = run?.candidates.find(item => item.candidate_id === state.selected?.candidate_id)
    ?? run?.candidates.find(item => run.pareto_ids.includes(item.candidate_id)) ?? run?.candidates.at(-1);
  const revisionContext = useRef({ runId: selected, candidateId: candidate?.candidate_id, stage: state.activeStage });
  revisionContext.current = { runId: selected, candidateId: candidate?.candidate_id, stage: state.activeStage };
  const runCandidates = run?.candidates;
  const lineage = useMemo(() => buildLineage(runCandidates ?? []), [runCandidates]);
  useEffect(() => {
    if (candidate && candidate.run_id !== state.selected?.run_id) {
      patch({ selected: candidate, draft: structuredClone(candidate.ir), dirty: false });
    }
  }, [candidate, state.selected?.run_id, patch]);

  function rememberSummary(summary: RunSummary) {
    listRevision.current += 1;
    setRuns(current => current?.some(item => item.id === summary.id)
      ? current.map(item => item.id === summary.id && item.updated_at <= summary.updated_at ? summary : item)
      : [summary, ...(current ?? [])]);
  }
  function showCreated(created: Run) {
    rememberSummary(created);
    setSelected(created.id);
    rememberRun(created);
  }
  async function createExperiment(request: ExperimentRequest) {
    const created = await api<Run>('/experiments', { method: 'POST', body: JSON.stringify(request) });
    showCreated(created);
    setCreateRequest(null);
  }
  async function runPreset(request: ExperimentRequest) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await createExperiment({ ...request, start_paused: false }); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function control(action: RunAction) {
    if (!run || busy) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<Run>(`${runPath(run.id)}/${action}`, { method: 'POST' });
      if (action === 'retry') showCreated(updated);
      else { rememberRun(updated); rememberSummary(updated); refresh(); }
    } catch (err) {
      setError((err as Error).message);
      refresh();
    } finally { setBusy(false); }
  }
  async function rename(target: RunSummary, name: string) {
    const request: RenameRunRequest = { name };
    const updated = await api<RunSummary>(runPath(target.id), { method: 'PATCH', body: JSON.stringify(request) });
    rememberName(updated);
    rememberSummary(updated);
    refresh();
    setRenameTarget(null);
  }
  async function deleteRun(target: RunSummary) {
    const force = isRunning(target.status);
    const activePrompt = `「${target.name}」正在运行或排队。强制删除会移除实验及其评估记录，且无法撤销。确定删除？`;
    if (busy || !window.confirm(force ? activePrompt : `确定删除「${target.name}」及其评估记录？此操作无法撤销。`)) return;
    setBusy(true);
    setError('');
    const requestDelete = (force: boolean) => api<void>(`${runPath(target.id)}?force=${force}`, { method: 'DELETE' });
    try {
      try { await requestDelete(force); }
      catch (err) {
        if (force || !(err instanceof ApiError) || err.status !== 409) throw err;
        if (!window.confirm(activePrompt)) return;
        await requestDelete(true);
      }
      removeRun(target.id);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function pruneCache() {
    if (pruningCache) return;
    setPruningCache(true);
    setCachePruneResult(null);
    setError('');
    try {
      setCachePruneResult(await api<CachePruneResult>('/cache/prune', {
        method: 'POST', body: JSON.stringify(cachePruneRequest),
      }));
    } catch (err) { setError((err as Error).message); }
    finally { setPruningCache(false); }
  }

  async function revisionCreated(revision: Candidate) {
    const latest = revisionContext.current;
    if (latest.runId !== revision.run_id) return;
    addRevision(revision);
    if (latest.stage === 'studio' && latest.candidateId === candidate?.candidate_id) {
      patch({ selected: revision, draft: structuredClone(revision.ir), dirty: false, activeStage: 'monitor', detailId: null, onlyPareto: false });
    }
    setRevisionNotice(`${GLOSSARY.manual_revision.uiLabel} ${revision.proposal_index + 1} 已保存，正在等待评估。`);
  }
  function seedExperiment(ir: DroneIR) {
    if (!run) return;
    const request = structuredClone(run.request);
    request.seed_ir = ir;
    request.goal.name = run.name.slice(0, 80) + ' · 微调后继续寻优';
    request.start_paused = false;
    setCreateRequest(request);
  }

  const activeRevision = state.selected?.source === 'manual_revision' ? candidate : run?.candidates.filter(c => c.source === 'manual_revision').at(-1);
  const revisionSettled = activeRevision && activeRevision.status !== 'NEW' && activeRevision.status !== 'L1_PASSED';
  const notice = revisionSettled ? `${GLOSSARY.manual_revision.uiLabel} ${activeRevision.proposal_index + 1} · ${statusNames[activeRevision.status]}` : revisionNotice;
  const workerMode = !state.health ? 'checking' : !state.health.worker_alive ? 'offline' : state.health.worker_status === 'busy' ? 'busy' : 'idle';
  const workerLabel = { checking: '正在检查计算服务', offline: '后台计算进程未运行', busy: '后台正在计算', idle: '后台计算就绪' }[workerMode];
  const activeCandidateId = workerMode === 'busy' ? state.health?.active_candidate_id : null;
  const currentWork = state.health?.active_run_id === run?.id ? run?.candidates.find(c => c.candidate_id === activeCandidateId) : undefined;
  const visibleError = error || feedError || listError;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark"><Layers3 size={23}/></span><span>翼构<span className="brand-caption">DRONE DESIGN LAB</span></span></a>
      <div className="workspace-label">工作空间 <span>LOCAL</span></div>
      <div className="nav-active"><FlaskConical size={18}/>设计实验室<span className="nav-count">{runs?.length ?? 0}</span></div>
      <div className="side-section"><span>我的实验</span><button className="side-plus" aria-label="新建实验" disabled={!defaults || busy} onClick={() => setCreateRequest(defaults)}><Plus size={17}/></button></div>
      <div className="run-list">
        {runs?.map(item => <div className={`run-row ${item.id === selected ? 'selected' : ''}`} key={item.id}>
          <button className={`run-item ${item.id === selected ? 'selected' : ''}`} aria-current={item.id === selected ? 'true' : undefined} onClick={() => {
            if (!busy && (selected === item.id || canLeave())) setSelected(item.id);
          }}><span className={`run-indicator ${item.status.toLowerCase()}`}/><span><strong title={item.name}>{item.name}</strong><small>{date(item.created_at)}</small></span></button>
          <div className="run-row-actions">
            <button type="button" aria-label={`重命名实验 ${item.name}`} title="重命名实验" disabled={busy} onClick={() => setRenameTarget(item)}><Pencil size={14}/></button>
            <button type="button" aria-label={`删除实验 ${item.name}`} title="删除实验" disabled={busy} onClick={() => void deleteRun(item)}><Trash2 size={14}/></button>
          </div>
        </div>)}
        {runs?.length === 0 && <p className="side-empty">暂无实验</p>}
      </div>
      <div className="side-bottom"><div className="local-card"><Box size={18}/><div>本地实验环境<small>核心仿真 · 可复现实验</small></div></div><a href="/docs" target="_blank" rel="noreferrer"><CircleHelp size={16}/>API 文档<ArrowUpRight size={14}/></a></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div><span>工作空间</span><span className="slash">/</span><strong>设计实验室</strong></div>
        <div className="connection"><span className={online ? 'online' : 'offline'}/>{online ? '服务已连接' : '连接中'}<span className="version">v{state.health?.version ?? '0.3'}</span></div></header>
      <main>
        <div className="page-heading"><div><h1>无人机设计实验室</h1><p>在虚拟飞行中比较不同的机型配置。</p></div>
          <button className="button primary" disabled={!defaults || busy} onClick={() => setCreateRequest(defaults)}><Plus size={18}/>新建实验</button></div>
        {visibleError && <div className="error-banner" role="alert"><span>{visibleError}</span>{error && <button aria-label="关闭提示" onClick={() => setError('')}><X size={16}/></button>}</div>}
        {runs?.length === 0 && <EmptyOnboarding presets={state.presets} error={presetsError} busy={busy} onRetry={reloadPresets}
          onRun={preset => void runPreset(preset.request)} onEdit={preset => setCreateRequest(preset.request)}/>}
        {!run && (runs === null || runs.length > 0) && <p className="muted" role="status">正在读取实验…</p>}
        {run && <>
          <section className="experiment-bar" aria-label="实验控制">
            <div className="experiment-title"><span className="experiment-icon"><FlaskConical size={21}/></span>
              <div><h2>{run.name}</h2><p><TermTooltip term={OPTIMIZER_TERMS[run.request.optimizer]}/> · {date(run.created_at)}</p></div>
              <Status value={run.status}/>
              <div className="experiment-diagnostics">
                <div className={`worker-status worker-${workerMode}`} role="status">
                  <strong>{workerLabel}{currentWork ? ` · 候选 ${currentWork.proposal_index + 1}` : ''}</strong>
                  {activeCandidateId && <span className="worker-candidate">编号 <code>{activeCandidateId}</code></span>}
                </div>
                <span className="cache-counter"><TermTooltip term="cache_hits"/> <strong>{run.cache_hits} 次</strong></span>
                <button type="button" className="button secondary compact" disabled={pruningCache} onClick={() => void pruneCache()}>
                  <Eraser size={15}/>{pruningCache ? '正在清理…' : '清理缓存'}
                </button>
              </div>
            </div>
            <StepperHeader key={run.id} run={run} activeStage={state.activeStage} busy={busy} onStage={setActiveStage}
              onConfig={() => setShowConfig(true)} onAdjust={() => setCreateRequest(run.request)} onControl={action => void control(action)}
              onRename={() => setRenameTarget(run)} onDelete={() => void deleteRun(run)}/>
          </section>
          {cachePruneResult && <div className="workbench-notice" role="status">已清理 {cachePruneResult.deleted} 条缓存，保留 {cachePruneResult.remaining} 条。
            <button aria-label="关闭缓存提示" onClick={() => setCachePruneResult(null)}><X size={15}/></button>
          </div>}
          {revisionNotice && <div className="workbench-notice" role="status">{notice}<button aria-label="关闭微调提示" onClick={() => setRevisionNotice('')}><X size={15}/></button></div>}
          {state.activeStage === 'monitor' && <WorkbenchMonitor run={run} candidate={candidate} transport={transport} lineage={lineage}/>}
          {state.activeStage === 'compare' && <ParetoDrawer key={run.id} embedded run={run}/>}
          {state.activeStage === 'studio' && (candidate
            ? <Studio key={candidate.candidate_id} embedded run={run} candidate={candidate} onRevision={revisionCreated} onNewExperiment={seedExperiment}/>
            : <section className="panel studio-awaiting"><h3>3D 改参</h3><p className="muted">生成第一个候选方案后，就可以在这里打开机型并调整参数。</p><button className="button secondary" onClick={() => setActiveStage('monitor')}>返回漏斗运行</button></section>)}
        </>}
        <footer>翼构 · 软件定义无人机实验平台</footer>
      </main>
    </div>
    {showConfig && run && <ExperimentDialog run={run} onClose={() => setShowConfig(false)}/>}
    {state.detailId && run && <CandidateDialog key={state.detailId} runId={run.id} candidateId={state.detailId} onClose={() => patch({ detailId: null })}
      onStudio={() => patch({ detailId: null, activeStage: 'studio', studioMode: 'edit' })}
      onReplay={() => patch({ detailId: null, activeStage: 'studio', studioMode: 'replay' })}/>}
    {createRequest && <CreateDialog defaults={createRequest} baselineIr={baselineIr} presets={state.presets}
      presetsError={presetsError} reloadPresets={reloadPresets} historicalRuns={runs ?? []} currentRun={run}
      studioDraft={state.draft} onClose={() => setCreateRequest(null)} onCreate={createExperiment}/>}
    {renameTarget && <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} onSave={name => rename(renameTarget, name)}/>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><WorkbenchProvider><App/></WorkbenchProvider></React.StrictMode>);
