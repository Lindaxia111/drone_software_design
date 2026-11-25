export type TermKey =
  | 'pareto' | 'only_pareto' | 'multi_objective' | 'convergence'
  | 'l1_screen' | 'l2_sim' | 'drone_ir' | 'seed_ir'
  | 'optimizer_evo' | 'optimizer_nsga2' | 'optimizer_rand' | 'step_response' | 'waypoints'
  | 'domain_rand' | 'fault_injection' | 'cascaded_pid'
  | 'manual_revision' | 'cache_hits' | 'ned_frame';

export interface TermEntry {
  key: TermKey;
  uiLabel: string;
  techTerm: string;
  plainDesc: string;
  decisionTip?: string;
}

export const EVALUATION_MODE_LABELS = { dynamics: '三维飞行模拟', demo: '快速演示' };

export const GLOSSARY: Record<TermKey, TermEntry> = {
  pareto: { key: 'pareto', uiLabel: '优选平衡方案', techTerm: '帕累托前沿 · Pareto Frontier', plainDesc: '这些方案各有长处，没有其他方案能在所有目标上超过它们。', decisionTip: '对比续航、稳定度和重量，挑最适合当前任务的方案。' },
  only_pareto: { key: 'only_pareto', uiLabel: '只看最优推荐', techTerm: '帕累托筛选 · Pareto Filter', plainDesc: '只显示综合权衡后值得进一步比较的方案。' },
  multi_objective: { key: 'multi_objective', uiLabel: '续航与稳定度权衡图', techTerm: '多目标权衡 · Multi-Objective Trade-off', plainDesc: '把续航和航迹偏差放在一张图里，便于看清各方案之间的取舍。' },
  convergence: { key: 'convergence', uiLabel: '设计效果提升曲线', techTerm: '寻优收敛 · Optimization Convergence', plainDesc: '看看随着候选方案增加，最好的结果还有多少进步。' },
  l1_screen: { key: 'l1_screen', uiLabel: '第 1 关：物理快速初筛', techTerm: 'L1 静态解析筛选 · L1 Analytic Screening', plainDesc: '先检查重量、动力余量和悬停条件，提前淘汰不合格的方案。' },
  l2_sim: { key: 'l2_sim', uiLabel: `第 2 关：${EVALUATION_MODE_LABELS.dynamics}`, techTerm: 'L2 六自由度动力学仿真 · 6-DOF Dynamics Simulation', plainDesc: '模拟无人机在空间中的移动和转动，检验飞得准不准、稳不稳。' },
  drone_ir: { key: 'drone_ir', uiLabel: '机型配置文件', techTerm: 'DroneIR · Intermediate Representation', plainDesc: '一份记录机架、旋翼、电池、载荷和飞控参数的文件。' },
  seed_ir: { key: 'seed_ir', uiLabel: '参考基准机型', techTerm: 'seed_ir · Seed Configuration', plainDesc: '选定一架飞机作为起点，让系统在它的基础上继续改进。' },
  optimizer_evo: { key: 'optimizer_evo', uiLabel: '智能进化搜索', techTerm: '进化优化 · Evolutionary Optimization', plainDesc: '用表现好的候选方案生成下一批方案，再反复比较。' },
  optimizer_nsga2: { key: 'optimizer_nsga2', uiLabel: '多目标前沿进化（NSGA-II）', techTerm: '第二代非支配排序遗传算法 · NSGA-II', plainDesc: '同时比较续航、稳定度等目标，保留各有优势的方案供你取舍。' },
  optimizer_rand: { key: 'optimizer_rand', uiLabel: '随机探索采样', techTerm: '随机搜索 · Random Search', plainDesc: '在指定范围随机抽取参数组，适合摸清范围和建立对比基线。' },
  step_response: { key: 'step_response', uiLabel: '定点突跃测试', techTerm: '阶跃响应 · Step Response', plainDesc: '在指定时间突然改变目标位置，观察响应速度和停靠精度。' },
  waypoints: { key: 'waypoints', uiLabel: '多点巡航路线', techTerm: '航点任务 · Waypoint Mission', plainDesc: '让无人机按设定时间飞过多个位置，比较它跟随路线的能力。' },
  domain_rand: { key: 'domain_rand', uiLabel: '制造误差鲁棒测试', techTerm: '域随机化 · Domain Randomization', plainDesc: '模拟机身重量的小幅波动，看看装配有误差时还能不能稳定飞行。' },
  fault_injection: { key: 'fault_injection', uiLabel: '突发故障容错测试', techTerm: '故障注入 · Fault Injection', plainDesc: '在模拟飞行时降低一只旋翼的推力，检查飞机能否稳住。' },
  cascaded_pid: { key: 'cascaded_pid', uiLabel: '双层自动飞控', techTerm: '串级 PID · Cascaded PID Controller', plainDesc: '外层决定往哪里飞，内层调整机身姿态以执行指令。' },
  manual_revision: { key: 'manual_revision', uiLabel: '手动微调版', techTerm: '人工修订 · Manual Revision', plainDesc: '手动更改机型参数后提交重评得到的方案，可和原方案对照。' },
  cache_hits: { key: 'cache_hits', uiLabel: '复用历史结果', techTerm: '缓存命中 · Evaluation Cache Hits', plainDesc: '遇到相同配置和测试条件时直接采用已有结果，省去重复计算。' },
  ned_frame: { key: 'ned_frame', uiLabel: '空间坐标（北、东、高度）', techTerm: 'NED 坐标系与 wxyz 四元数 · NED Frame & Quaternion', plainDesc: '界面用北、东和离地高度描述位置，数据文件中的第三轴向下为正。' },
};

export const PARETO_FRONT_LABEL = '最优权衡线';

export const MISSION_LABELS = {
  hover: '悬停稳态',
  step_response: GLOSSARY.step_response.uiLabel,
  waypoints: GLOSSARY.waypoints.uiLabel,
};

export const OPTIMIZER_TERMS = { evolution: 'optimizer_evo', nsga2: 'optimizer_nsga2', random: 'optimizer_rand' } as const;
export const OPTIMIZER_LABELS = {
  evolution: GLOSSARY[OPTIMIZER_TERMS.evolution].uiLabel,
  nsga2: GLOSSARY[OPTIMIZER_TERMS.nsga2].uiLabel,
  random: GLOSSARY[OPTIMIZER_TERMS.random].uiLabel,
};

export function evaluationLevelLabel(level: string, mode: keyof typeof EVALUATION_MODE_LABELS) {
  if (level === 'L1') return GLOSSARY.l1_screen.uiLabel;
  if (level === 'L2') return mode === 'demo' ? '第 2 关：快速演示评估' : GLOSSARY.l2_sim.uiLabel;
  return '扩展评估';
}
