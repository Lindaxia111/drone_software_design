# 第一阶段验收记录

日期：2026-11-24（Asia/Shanghai）。验证对象：v0.1.0 本地工程闭环。

## 自动验证

- `python -m pytest -q`：14 项通过。覆盖完整实验、同种子复现、缓存复用、新约束重筛、L1/L2 预算预占、暂停恢复、中断尝试恢复、真实 Worker 进程终止/重启、故障不入缓存、时间预算、取消、物理基准、帕累托支配、API 校验/导出与 Worker 排他锁。
- 生成 7 份 JSON Schema、前端 TypeScript 契约及 3 份样例；实验详情、摘要和候选类型均来自 Pydantic。
- `npm run build`：TypeScript 检查与 Vite 生产构建通过。
- `scripts/dev.ps1 -SkipBuild -Port 8010`：启动成功，主页返回 200，创建的 2 候选实验由独立 Worker 完成。
- `node tests/browser-smoke.cjs`：本机无头 Chrome 验证创建、暂停、恢复、完成、下载报告和 DroneIR；验证重复实验缓存以及手机无页面级横向溢出；没有浏览器运行时异常。

浏览器基准实验为 3 代、每代 8 个候选、seed=42：24 个候选、17 个通过、7 个约束淘汰。重复配置命中 41 次缓存，L1/L2 实际派发次数均为 0。桌面 1500px 与手机 390px 截图位于 `tmp/screenshots/`，已进行目视检查。

测试使用临时数据库，不依赖 Redis、Docker、PostgreSQL 或真实飞控。

## 已知限制

- 依赖中的 Starlette TestClient 触发一条 AnyIO API 弃用提示；测试正常通过。
- SQLite 只支持本机单 Worker；未验证分布式调度或高并发吞吐。
- L1 是简化解析模型，L2 为演示数据，尚未完成可信动力学、控制分配、真实寻优算法或 L3。
- 当前报告为 JSON，当前构型图为俯视简图，尚未接入 PDF 报告、遥测或 3D 轨迹回放。

这些检查验证软件工程闭环，不构成无人机性能或飞行安全验证。
