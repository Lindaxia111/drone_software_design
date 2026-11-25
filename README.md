# 翼构 · 无人机设计实验室

面向多旋翼构型的本地设计与仿真实验平台：配置目标和约束，生成候选，通过分层评估比较方案，并查看参数、执行记录和轨迹。

当前版本为 **v0.2.0**。工作台默认使用 6-DOF 动力学和进化搜索，也支持随机搜索与快速演示。模型用于探索期相对比较，L3 高保真仿真尚未接入。

## 启动

当前工作区已准备运行环境，在项目根目录执行：

```powershell
./scripts/dev.ps1
```

打开 <http://127.0.0.1:8000>。全新环境请先按 [安装与启动](docs/guides/quickstart.md) 准备 Python 3.12+ 和 Node.js 20+。

## 文档入口

完整导航见 [项目文档](docs/README.md)。

| 要做的事情 | 对应文档 |
|---|---|
| 安装、启动或排查启动问题 | [安装与启动](docs/guides/quickstart.md) |
| 配置实验、暂停、查看候选参数与导出 | [实验操作指南](docs/guides/experiments.md) |
| 理解模块、数据、仿真与恢复机制 | [工程架构](docs/architecture/overview.md) |
| 开发、运行测试、生成契约 | [开发指南](docs/development/guide.md) |
| 查看已完成能力和后续工作 | [开发路线](docs/development/roadmap.md) |
| 核对验证结果与覆盖范围 | [验证记录](docs/quality/validation.md) |
| 了解版本变化 | [变更记录](docs/releases/changelog.md) |

## 目录职责

```text
apps/          后端应用、仿真核心与前端工作台
docs/          使用、架构、开发、质量与版本文档
examples/      实验、构型和场景 JSON 示例
schemas/       自动生成的 JSON Schema
scripts/       启动与契约生成脚本
tests/         应用回归、核心物理与浏览器验收
data/          本地实验数据库，运行时生成
```

当前采用独立 API/Worker 与 SQLite，本地每个数据库运行一个 Worker。完整能力边界见 [工程架构](docs/architecture/overview.md#能力边界)。
