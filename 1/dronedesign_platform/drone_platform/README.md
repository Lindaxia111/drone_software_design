# dronedesign —— 软件定义无人机自动设计与仿真验证平台（核心引擎）

按《架构设计文档 v1.0》实现的**纯软件闭环**：参数化定义（Drone-as-Code）→ 多级漏斗仿真 → 自动迭代寻优 → 复盘对比。
对应文档路线图的阶段一，并提前完成了阶段二中不依赖外部包的部分（真实 L1 物理、自研 6-DOF L2）。

```bash
python -m pytest -q            # 31 个测试，约 15 s
python examples/demo.py        # 端到端寻优，约 20 s → out/report.md, out/run.json, out/best_replay.json
```

依赖仅 `pydantic>=2.5 numpy scipy`（Python ≥ 3.11）。

## 文档章节 → 代码

| 文档 | 模块 | 说明 |
|---|---|---|
| 二、五大实体 | `schema.py` | `DesignGoal / DroneIR / TestScenario / EvalResult`（Pydantic v2，IR 不可变） |
| 二、数据铁律 | `schema.py` | SI+FRD；`ir_hash`=规范化 JSON 的 SHA-256（9 位有效数字、旋翼顺序无关）；缓存键含 `schema_version` |
| 二、SPI | `spi.py` | `IOptimizer / IEvaluator / ICompiler` |
| 三、4A 寻优层 | `optimizers/` | 随机搜索、(μ+λ) 进化策略 |
| 三、4B / 四、漏斗 | `evaluators/l1.py`, `l2.py` | L1 约 0.3 ms；L2 约 0.3~1 s（多进程 Worker 池可选） |
| 三、3 编排层 | `orchestrator.py` | 状态机、预算守卫、缓存拦截、漏斗分发/汇聚、Top-K 终审、帕累托 |
| 三、5 存储层 | `cache.py` | SQLite 内容寻址缓存（`:memory:` 或文件） |
| 实验追踪 | `report.py` | Markdown 报告、实验谱系、Three.js 轨迹回放 JSON |

## 物理模型（以及它的边界）

**L1**：合成质量/重心/惯量；用有界最小二乘求悬停推力分配（同时检验力与力矩平衡，可处理重心偏移与倾斜旋翼）；
动量理论悬停/峰值功率；航时 = 80% 放电深度 × 容量 / 悬停功率；桨盘球近似干涉检测；4 行分配矩阵求秩判可控性。

**L2**：6-DOF 刚体 + 一阶电机 + 线性阻力 + 恒定风/阵风；级联 PID（位置→姿态→速率→分配）；
领域随机化（质量±x%，控制器仍用名义质量，种子由内容派生故可复现）；故障注入（`motor_out` / `thrust_loss`）。
活动旋翼 ≤5 的故障下放弃偏航通道——精确偏航平衡会把对侧电机压到 0 N 而失去滚转/俯仰余量。
测试里的容错排序符合物理预期：**四旋翼单电机失效坠毁，六旋翼/八旋翼保持悬停**。

这是**探索期的排序级**模型，不是真机预测：推力-油门线性、电池恒压、无地面效应/桨间气动干扰、电机质量并入机体、
惯量为粗估。绝对数值（尤其航时）只宜用于方案间相对比较。

## 对文档契约的扩展（均为向后兼容的新增字段）

- `IEvaluator.version`：评估器逻辑升级后缓存自动失效。
- `Mission.altitude_m / step_m / step_time_s`；waypoint 格式 `{"t_s": 3, "position_m": [x, y, z]}`（NED，向上为负）。
- `EvalResult.error`、`Violation.message`：崩溃/异常摘要。
- 虚拟参数路径（`irtools.VIRTUAL_PARAMS`）：`rotors[*].arm_length_m`（文档示例里的臂长，IR 本身只存坐标）、
  `power.capacity_wh_coupled`（容量与电池质量按 180 Wh/kg 联动，否则优化器会"白嫖"容量）。

## 编排语义（容易踩坑处）

- 缓存键 = schema 版本 + `ir_hash` + 场景内容哈希 + 层级 + 评估器版本；`TIMEOUT` 不入缓存；约束与适应度在缓存**之外**叠加，所以改约束不会让缓存失效。
- 预算按**实际执行**的评估次数计（缓存命中免费）；L2 的一次 = 一个 (方案 × 场景)。预算不足时，L1 通过者按 L1 适应度排序晋级，其余保留 L1 结果并终止实验。
- 多场景聚合：状态取最差；出现在约束/目标中的指标取最坏情况，其余取均值。
- 不可行方案带分级惩罚适应度（违约越轻分越高），进化策略因此能从不可行区爬回可行域。

## 尚未实现（文档中属于后续阶段 / 环境限制）

- FastAPI 接入层与 React/Three.js 前端、Redis+Celery 队列、PostgreSQL/MinIO：当前环境没有 fastapi 且无法联网安装，未写未经运行验证的代码。`ExperimentRun` 已可 `model_dump_json()`，`export_replay()` 已输出前端回放所需格式，接 API 时直接复用。
- Optuna（贝叶斯）/ PyMOO（NSGA-II）：目前是单目标进化策略；多目标靠加权和 + 事后帕累托。需要在 `IOptimizer` 下新增插件即可。
- `ICompiler`（SDF / PX4 参数 / RotorPy）与 L3 PX4+Gazebo 容器评估器：仅有接口；编排器的 Top-K 终审路径已用 L3 桩评估器测试。
- L2 控制器仅支持 `cascaded_pid`；`lqr`/`mpc` 会被以 `unsupported_controller` 拒绝。
- 拓扑（旋翼数量）不在 `param_path` 搜索范围内，换拓扑需换种子机型（`make_multirotor(n_rotors=…)`）。
