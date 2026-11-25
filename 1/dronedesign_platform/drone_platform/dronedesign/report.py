"""实验复盘：Markdown 体检报告 + 供 Three.js 本地回放的轨迹 JSON。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .evaluators.l2 import simulate
from .orchestrator import ExperimentRun
from .schema import DroneIR, TestScenario


def _fmt(x: Optional[float], nd: int = 3) -> str:
    return "—" if x is None else f"{x:.{nd}f}"


def build_report(run: ExperimentRun) -> str:
    g = run.goal
    L: list[str] = []
    dur = (run.finished_at or 0) - (run.started_at or 0)
    L += [f"# 实验报告：{g.name}", "", f"- run_id：`{run.run_id}`　状态：**{run.state.value}**　耗时：{dur:.1f}s",
          f"- 预算使用：{run.budget_used}　缓存命中：{run.cache_hits}", ""]

    # 漏斗
    tot_new = sum(s.new for s in run.generations)
    tot_l1p = sum(s.l1_passed for s in run.generations)
    tot_l2 = sum(s.l2_promoted for s in run.generations)
    tot_l2p = sum(s.l2_passed for s in run.generations)
    L += ["## 仿真漏斗", "", "| 层级 | 进入 | 通过 | 淘汰率 |", "|---|---|---|---|",
          f"| L1 静态解析 | {tot_new} | {tot_l1p} | {(1 - tot_l1p / tot_new) * 100 if tot_new else 0:.0f}% |",
          f"| L2 轻量动力学 | {tot_l2} | {tot_l2p} | {(1 - tot_l2p / tot_l2) * 100 if tot_l2 else 0:.0f}% |"]
    n_l3 = sum(1 for r in run.candidates.values() if r.l3)
    if n_l3:
        n_l3p = sum(1 for r in run.candidates.values() if r.l3 and r.l3.feasible)
        L.append(f"| L3 高保真 | {n_l3} | {n_l3p} | {(1 - n_l3p / n_l3) * 100:.0f}% |")
    L.append("")

    # 收敛
    L += ["## 收敛曲线（历史最优适应度）", "", "| 代 | 本代最优 | 历史最优 | L1执行 | L2晋级 | 缓存命中 |", "|---|---|---|---|---|---|"]
    for s in run.generations:
        L.append(f"| {s.generation} | {_fmt(s.gen_best_fitness)} | {_fmt(s.best_fitness_so_far)} | "
                 f"{s.l1_executed} | {s.l2_promoted} | {s.cache_hits} |")
    L.append("")

    # 最优方案
    if run.best_hash:
        rec = run.candidates[run.best_hash]
        ir = rec.ir
        m = rec.final.metrics  # type: ignore[union-attr]
        L += ["## 最优构型", "", f"- ir_hash：`{ir.ir_hash[:16]}…`　验证层级：{rec.final_level}　适应度：{rec.final.fitness_score:.3f}",  # type: ignore[union-attr]
              f"- 谱系深度：{len(run.lineage(ir.ir_hash))}", "",
              "| 指标 | 值 |", "|---|---|"]
        for k in sorted(m):
            L.append(f"| {k} | {m[k]:.4g} |")
        r0 = ir.rotors[0]
        L += ["", "关键设计参数：",
              f"- 旋翼数 {len(ir.rotors)}，臂长 {(r0.position_m[0] ** 2 + r0.position_m[1] ** 2) ** 0.5:.3f} m，"
              f"单桨最大推力 {r0.max_thrust_n:.2f} N，桨半径 {r0.prop_radius_m:.3f} m",
              f"- 电池 {ir.power.capacity_wh:.1f} Wh / {ir.power.battery_mass_kg:.3f} kg，机体 {ir.airframe.base_mass_kg:.2f} kg，"
              f"载荷 {ir.payload.mass_kg:.2f} kg", ""]
    else:
        L += ["## 最优构型", "", "没有找到同时满足全部约束的方案。建议放宽约束或扩大搜索空间。", ""]

    # 帕累托
    if len(g.objectives) > 1 and run.pareto_hashes:
        L += ["## 帕累托前沿", "", "| ir_hash | " + " | ".join(o.metric for o in g.objectives) + " |",
              "|---|" + "---|" * len(g.objectives)]
        for h in run.pareto_hashes:
            m = run.candidates[h].final.metrics  # type: ignore[union-attr]
            L.append(f"| `{h[:10]}` | " + " | ".join(f"{m[o.metric]:.4g}" for o in g.objectives) + " |")
        L.append("")
    return "\n".join(L)


def export_replay(ir: DroneIR, scenario: TestScenario, path: str | Path, fps: float = 30.0) -> Path:
    """跑一次 L2 仿真并导出 Three.js 可直接读取的轨迹（FRD 坐标，四元数 wxyz）。"""
    every = max(1, int(round(1.0 / (fps * scenario.sim_dt_s))))
    out = simulate(ir, scenario, record_every=every)
    doc = {
        "schema": "dronedesign.replay/1",
        "frame": "FRD",
        "ir_hash": ir.ir_hash,
        "scenario_id": scenario.scenario_id,
        "crashed": out.crashed,
        "rotors": [{"id": r.id, "position_m": r.position_m, "prop_radius_m": r.prop_radius_m,
                    "spin_direction": r.spin_direction} for r in ir.rotors],
        "columns": ["t", "x", "y", "z", "qw", "qx", "qy", "qz"],
        "frames": [[round(v, 5) for v in f] for f in out.frames],
    }
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(doc, separators=(",", ":")))
    return p
