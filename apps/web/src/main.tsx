import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowUpRight, Box, Check, CircleHelp, Download, FlaskConical, Layers3, Pause, Play, Plus, Radio, RotateCcw, Square, Wind, X } from 'lucide-react';
import { api, type Candidate, type ExperimentRequest, type Run, type RunSummary } from './api';
import { CreateDialog } from './components/CreateDialog';
import { CandidateDialog, ExperimentDialog } from './components/DetailsDialog';
import { WorkbenchProvider, useWorkbenchStore } from './workbench/state';
import { Convergence, Pareto } from './workbench/LinkedCharts';
import { ParetoDrawer } from './workbench/ParetoDrawer';
import { CandidatePreview, Studio } from './workbench/Studio';
import type { DroneIR } from './contracts';
import './style.css';
import './workbench/workbench.css';

const statusNames: Record<string, string> = { QUEUED: '等待计算', RUNNING: '运行中', PAUSED: '已暂停', CANCELLED: '已取消', COMPLETED: '已完成', NEW: '待评估', L1_PASSED: '等待 L2', PASSED: '通过', REJECTED_CONSTRAINT: '约束淘汰', SKIPPED: '预算跳过', CRASHED: '执行失败', UNSUPPORTED: '构型不支持', TIMEOUT: '超时' };
const reasonNames: Record<string,string> = {SEARCH_EXHAUSTED: '搜索完成', L1_BUDGET: 'L1 预算耗尽', L2_BUDGET: 'L2 预算耗尽', TIME_BUDGET: '运行时间达到上限'};
const num = (value: number | undefined, digits = 2) => value === undefined ? '—' : value.toFixed(digits);
const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});

function Status({value}: {value: string}) { return <span className={`badge ${value.toLowerCase()}`}>{value === 'RUNNING' && <span className="pulse"/>}{statusNames[value] || value}</span>; }

function App() {
  const workbench=useWorkbenchStore();
  const {state,patch,select:selectCandidate}=workbench;
  const [showConfig,setShowConfig]=useState(false);
  const [createDefaults,setCreateDefaults]=useState<ExperimentRequest|null>(null),[revisionNotice,setRevisionNotice]=useState('');
  const detailId=state.detailId;
  const setDetailId=(id:string|null)=>patch({detailId:id});
  const mutationEpoch=useRef(0);
  const [runs,setRuns]=useState<RunSummary[]>([]),[selected,setSelected]=useState<string|null>(null),[run,setRun]=useState<Run|null>(null),[defaults,setDefaults]=useState<ExperimentRequest|null>(null),[error,setError]=useState(''),[online,setOnline]=useState(false),[modal,setModal]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{api<{request:ExperimentRequest}>('/defaults').then(d=>setDefaults(d.request)).catch(e=>setError(e.message));},[]);
  useEffect(()=>{
    let disposed=false;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    setRun(current=>current?.id===selected?current:null);workbench.clear();setShowConfig(false);setRevisionNotice('');
    const refresh=async()=>{const epoch=mutationEpoch.current;try{const [list,detail]=await Promise.all([api<RunSummary[]>('/experiments',{signal:controller.signal}), selected?api<Run>(`/experiments/${selected}`,{signal:controller.signal}):Promise.resolve(null)]);if(disposed||epoch!==mutationEpoch.current)return;setRuns(list);setRun(detail);setOnline(true);setSelected(previous=>previous??list[0]?.id??null);}catch(e){if(!disposed){setOnline(false);setError((e as Error).message);}}finally{if(!disposed)timer=setTimeout(refresh,1000);}};
    void refresh();return()=>{disposed=true;controller.abort();clearTimeout(timer);};
  },[selected]);
  const candidate=run?.candidates.find(c=>c.candidate_id===state.selected?.candidate_id)??run?.candidates.find(c=>run.pareto_ids.includes(c.candidate_id))??run?.candidates.at(-1);
  useEffect(()=>{if(candidate&&candidate.run_id===selected&&(!state.selected||state.selected.run_id!==selected))patch({selected:candidate,draft:structuredClone(candidate.ir),dirty:false});},[candidate?.candidate_id,selected,state.selected?.run_id]);
  const passed=run?.candidates.filter(c=>c.status==='PASSED')??[];
  const bestFlight=passed.length?Math.max(...passed.map(c=>c.metrics.flight_time_min)):undefined;
  const bestError=passed.length?Math.min(...passed.map(c=>c.metrics.tracking_rmse_m)):undefined;
  const target=(run?.budget.max_generations??0)*(run?.budget.batch_size??0)+(run?.candidates.filter(c=>c.source==='manual_revision').length??0);
  const settled=run?.candidates.filter(c=>!['NEW','L1_PASSED'].includes(c.status)).length??0;
  async function control(action:string) {
    if(!run||busy)return;
    mutationEpoch.current+=1;setBusy(true);
    try {
      const updated=await api<Run>(`/experiments/${run.id}/${action}`,{method:'POST'});
      if(action==='retry'){setRuns(previous=>[updated,...previous]);setSelected(updated.id);}
      setRun(updated);
    } catch(e) {
      setError((e as Error).message);
      try{setRun(await api<Run>(`/experiments/${run.id}`));}catch{/* polling retries */}
    } finally {mutationEpoch.current+=1;setBusy(false);}
  }
  const isDynamics=run?.request.evaluation_mode==='dynamics';
  const latestRevision=run?.candidates.filter(c=>c.source==='manual_revision').at(-1);
  const visibleRevisionNotice=revisionNotice&&latestRevision&&!['NEW','L1_PASSED'].includes(latestRevision.status)?`手动修订候选 ${latestRevision.proposal_index+1}：${statusNames[latestRevision.status]}。${latestRevision.status==='SKIPPED'?'评估预算已耗尽，可另建实验。':'可在图表和详情中对比结果，原候选记录保持不变。'}`:revisionNotice;
  const candidates=[...(run?.candidates??[])].filter(c=>!state.onlyPareto||run?.pareto_ids.includes(c.candidate_id)).reverse();
  async function revisionCreated(revision:Candidate){
    if(!run)return;mutationEpoch.current+=1;
    setRun(current=>current&&current.id===run.id?{...current,candidates:[...current.candidates.filter(c=>c.candidate_id!==revision.candidate_id),revision]}:current);
    patch({selected:revision,draft:structuredClone(revision.ir),dirty:false,studioOpen:false,detailId:null});
    setRevisionNotice(`手动修订候选 ${revision.proposal_index+1} 已保存，正在等待 L1/L2 评估。原候选参数保持不变。`);
    try{const updated=await api<Run>(`/experiments/${run.id}`);setRun(current=>current?.id===updated.id?updated:current);}catch{/* already accepted; polling refreshes without resubmitting */}
    finally{mutationEpoch.current+=1;}
  }
  function seedExperiment(ir:DroneIR){if(!run)return;const request=structuredClone(run.request);request.seed_ir=ir;request.goal.name=run.name.slice(0,80)+' · 修订寻优';request.start_paused=false;setCreateDefaults(request);setModal(true);}
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/"><span className="brand-mark"><Layers3 size={23}/></span><span>翼构<span className="brand-caption">DRONE DESIGN LAB</span></span></a>
      <div className="workspace-label">工作空间 <span>LOCAL</span></div><div className="nav-active"><FlaskConical size={18}/>设计实验室<span className="nav-count">{runs.length}</span></div>
      <div className="side-section"><span>我的实验</span><button className="side-plus" aria-label="新建实验" onClick={()=>{setCreateDefaults(null);setModal(true);}} disabled={!defaults}><Plus size={17}/></button></div>
      <div className="run-list">{runs.map(r=><button key={r.id} className={`run-item ${r.id===selected?'selected':''}`} onClick={()=>{if(workbench.canLeave())setSelected(r.id);}}><span className={`run-indicator ${r.status.toLowerCase()}`}/><span><strong>{r.name}</strong><small>{date(r.created_at)}</small></span></button>)}{!runs.length&&<p className="side-empty">创建第一个实验，开始探索。</p>}</div>
      <div className="side-bottom"><div className="local-card"><Box size={18}/><div>本地实验环境<small>核心仿真 · 可复现实验</small></div></div><a href="/docs" target="_blank" rel="noreferrer"><CircleHelp size={16}/> API 文档 <ArrowUpRight size={14}/></a></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div><span>工作空间</span><span className="slash">/</span><strong>设计实验室</strong></div><div className="connection"><span className={online?'online':'offline'}/>{online?'服务已连接':'连接中'}<span className="version">v0.3</span></div></header>
      <main><div className="page-heading"><div><div className="eyebrow">VIRTUAL FLIGHT, BETTER DESIGN</div><h1>让每一次设计，都有据可循。</h1><p>定义目标，探索构型，在虚拟实验中找到更好的飞行方案。</p></div><button className="button primary" onClick={()=>{setCreateDefaults(null);setModal(true);}} disabled={!defaults}><Plus size={18}/>新建实验</button></div>
        {revisionNotice&&<div className="workbench-notice" role="status">{visibleRevisionNotice}<button aria-label="关闭修订提示" onClick={()=>setRevisionNotice('')}><X size={15}/></button></div>}
        {error&&<div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={()=>setError('')}><X size={16}/></button></div>}
        <div className="demo-banner"><FlaskConical size={18}/><span><strong>{isDynamics?"动力学实验模式":"实验工作台"}</strong>{isDynamics?"L1 配平与可控性检查，L2 刚体动力学与闭环控制。结果用于探索期相对比较。":run?"当前实验使用演示评估，历史结果保留原验证等级。":"支持 6-DOF 动力学、故障注入和参数化寻优。创建实验时选择评估模式。"}</span><span className="demo-tag">{isDynamics?"6-DOF":run?"DEMO":"LAB"}</span></div>
        <section className="experiment-bar"><div className="experiment-title"><span className="experiment-icon"><FlaskConical size={21}/></span><div><h2>{run?.name??'准备开始你的第一次实验'}</h2><p>{run?`${run.id.slice(0,8)} · ${run.request.optimizer==='evolution'?'进化搜索':'随机搜索'} · seed ${run.seed} · ${date(run.created_at)}`:'创建目标与约束，系统将自动生成并评估候选方案。'}</p></div>{run&&<Status value={run.status}/>}</div><div className="actions">{run&&<>
          <button className="button secondary compact" onClick={()=>setShowConfig(true)}>实验参数</button>
          <button className="button secondary compact" disabled={busy||run.status!=='PAUSED'} onClick={()=>control('resume')}><Play size={15}/>{run.next_index===0?'启动':'继续'}</button>
          <button className="button secondary compact pause-control" title={['COMPLETED','CANCELLED'].includes(run.status)?'实验已结束，可点击重新测试':'暂停后不再派发新任务，当前任务会完成归档'} disabled={busy||!['RUNNING','QUEUED'].includes(run.status)} onClick={()=>control('pause')}><Pause size={15}/>暂停</button>
          <button className="button secondary compact" disabled={busy||!['RUNNING','QUEUED','PAUSED'].includes(run.status)} onClick={()=>control('cancel')}><Square size={15}/>取消实验</button>
          <button className="button secondary compact" disabled={busy} onClick={()=>control('retry')}><RotateCcw size={15}/>重新测试</button>
          <a className="button secondary compact" href={`/api/experiments/${run.id}/report`} download><Download size={15}/>导出报告</a>
        </>}</div></section>
        {run&&<p className="lifecycle-hint">{['COMPLETED','CANCELLED'].includes(run.status)?'本次实验已结束。暂停仅在运行中可用，点击“重新测试”可按原参数创建新实验。':run.status==='PAUSED'?'实验已暂停。点击启动或继续，从已有进度接着运行。':'运行中可随时暂停；已派发任务完成后归档，不会继续生成新任务。'}</p>}
        <div className="stat-grid"><div className="stat-card"><div><span>已评估候选</span><Layers3 size={17}/></div><strong>{settled}<small> / {target||'—'}</small></strong><p>{run?.passed??0} 个通过 · {run?.rejected??0} 个约束淘汰</p></div><div className="stat-card"><div><span>最佳续航估算</span><Wind size={17}/></div><strong>{num(bestFlight)}<small> min</small></strong><p>简化功耗模型 · 可用电量 80%</p></div><div className="stat-card"><div><span>最小跟踪误差</span><Activity size={17}/></div><strong>{num(bestError,3)}<small> m</small></strong><p>{isDynamics?"闭环位置跟踪 RMSE":"合成演示指标 · 非动力学结果"}</p></div><button className="stat-card pareto-card" aria-label="查看帕累托方案" disabled={!run?.pareto_ids.length} onClick={()=>patch({paretoOpen:true})}><div><span>帕累托方案</span><Radio size={17}/></div><strong>{run?.pareto_ids.length??0}<small> 个</small></strong><p>{run?.pareto_ids.length?"查看方案集合与参数对比":"暂无帕累托方案"}</p></button></div>
        <div className="analysis-grid"><section className="panel convergence"><div className="panel-heading"><h3>寻优收敛趋势</h3><span className="legend"><i/>最佳续航估算</span></div><Convergence run={run}/><div className="chart-footer"><span>累计候选评估</span><span>运行时间 <strong>{clock(run?.elapsed_sec??0)}</strong></span></div></section><section className="panel"><div className="panel-heading"><h3>多目标权衡</h3><span className="legend"><i/>帕累托方案</span></div><Pareto run={run}/><div className="chart-footer">{isDynamics?'在已通过的动力学方案中寻找更优组合':'在已通过的演示方案中寻找更优组合'}</div></section></div>
        <div className="lower-grid"><section className="panel funnel-panel"><div className="panel-heading"><h3>评估流水线</h3><span className="subtle">分层筛选</span></div>{[['L1','静态解析',run?.l1_used??0,run?.budget.max_l1_evals??0,'active'],['L2',isDynamics?'动力学仿真':'演示评估',run?.l2_used??0,run?.budget.max_l2_evals??0,'purple'],['L3','高保真终审',0,0,'disabled']].map(([level,label,used,limit,style])=><div className={`funnel-row ${style}`} key={level}><span className="level-tag">{level}</span><div><strong>{label}</strong><div className="progress-track"><span style={{width:`${Number(limit)?Math.min(100,Number(used)/Number(limit)*100):0}%`}}/></div></div><span>{level==='L3'?'待接入':`${used} / ${limit}`}</span></div>)}<div className="budget-meta"><span>缓存命中 <strong>{run?.cache_hits??0}</strong></span><span>预算按实际派发计数</span></div>{run?.stop_reason&&<p className="stop-reason"><Check size={14}/>{reasonNames[run.stop_reason]??run.stop_reason}</p>}</section>
          <CandidatePreview candidate={candidate}/></div>
        <section className="panel results-panel" id="candidate-results"><div className="panel-heading"><div className="inline-title"><h3>候选方案</h3><span className="count">{run?.candidates.length??0}</span></div><div className="candidate-filter"><button aria-pressed={!state.onlyPareto} onClick={()=>patch({onlyPareto:false})}>全部候选</button><button aria-pressed={state.onlyPareto} onClick={()=>patch({onlyPareto:true})}>仅看帕累托</button></div></div><div className="table-scroll"><table><thead><tr><th>方案</th><th>代数</th><th>质量 / kg</th><th>续航 / min</th><th>误差 / m</th><th>评估状态</th><th>多目标评价</th><th>参数详情</th></tr></thead><tbody>{candidates.map(c=><React.Fragment key={c.candidate_id}><tr tabIndex={0} aria-label={`查看候选 ${c.proposal_index+1}`} className={candidate?.candidate_id===c.candidate_id?'focused':''} onClick={()=>selectCandidate(c)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectCandidate(c);}}}><td><strong>{c.source==='manual_revision'?'◆ 修订':'方案'} {String(c.proposal_index+1).padStart(3,'0')}</strong><small>{c.ir_hash.slice(0,8)}</small></td><td>{c.source==='manual_revision'?'手动':`G${String(c.generation).padStart(2,'0')}`}</td><td>{num(c.metrics.total_mass_kg,3)}</td><td>{num(c.metrics.flight_time_min)}</td><td>{num(c.metrics.tracking_rmse_m,3)}</td><td><Status value={c.status}/></td><td>{run?.pareto_ids.includes(c.candidate_id)?<span className="pareto-label"><Check size={13}/>帕累托前沿</span>:'—'}</td><td><button className="button secondary compact" onClick={e=>{e.stopPropagation();selectCandidate(c,true);}}>查看参数</button></td></tr>{state.selected?.candidate_id===c.candidate_id&&c.violations.length>0&&<tr className="violation-row"><td colSpan={8}>{c.violations.map(v=>`${v.rule}：实际 ${num(v.actual,3)}，阈值 ${num(v.limit,3)}`).join('；')}</td></tr>}</React.Fragment>)}{!candidates.length&&<tr><td colSpan={8}><div className="empty-state"><FlaskConical size={28}/><strong>等待第一组候选方案</strong><span>{run?'请确认计算 Worker 已启动，评估结果将自动出现在这里。':'新建一个实验，开始探索设计空间。'}</span></div></td></tr>}</tbody></table></div></section>
        <section className="panel event-panel"><div className="panel-heading"><h3>运行日志</h3><span className="subtle"><RotateCcw size={13}/> 每秒更新</span></div><div className="event-list">{run?.events.slice(-12).reverse().map(e=><div key={e.seq}><time>{new Date(e.created_at*1000).toLocaleTimeString('zh-CN')}</time><span className={`event-kind ${e.kind.toLowerCase()}`}>{e.kind}</span><span>{e.message}</span></div>)}{!run?.events.length&&<p className="muted">实验生命周期与评估事件将在此记录。</p>}</div></section>
        <footer>翼构 · 软件定义无人机实验平台<span>参数化设计 / 分层评估 / 可复现实验</span></footer>
      </main>
    </div>
    {state.paretoOpen&&run&&<ParetoDrawer run={run}/>}
    {state.studioOpen&&run&&candidate&&<Studio run={run} candidate={candidate} onRevision={revisionCreated} onNewExperiment={seedExperiment}/>}
    {showConfig&&run&&<ExperimentDialog run={run} onClose={()=>setShowConfig(false)}/>}
    {detailId&&run&&<CandidateDialog runId={run.id} candidateId={detailId} onClose={()=>setDetailId(null)} onStudio={()=>patch({detailId:null,studioOpen:true})}/>}
    {modal&&defaults&&<CreateDialog defaults={createDefaults??defaults} onClose={()=>setModal(false)} onCreate={async request=>{const created=await api<Run>('/experiments',{method:'POST',body:JSON.stringify(request)});mutationEpoch.current+=1;setRuns(previous=>[created,...previous]);setSelected(created.id);setRun(created);setModal(false);}}/>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><WorkbenchProvider><App/></WorkbenchProvider></React.StrictMode>);
