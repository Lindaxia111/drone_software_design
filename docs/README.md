# 项目文档

本文档集描述当前工程，按用途组织。当前实现、后续计划和历史记录分别维护。

## 阅读路径

| 任务 | 文档 |
|---|---|
| 首次使用 | [安装与启动](guides/quickstart.md) → [实验操作](guides/experiments.md) |
| 开发维护 | [工程架构](architecture/overview.md) → [开发指南](development/guide.md) |
| 规划后续开发 | [开发路线](development/roadmap.md) |
| 检查交付与回归 | [验证记录](quality/validation.md) |
| 了解版本变化 | [变更记录](releases/changelog.md) |

## 目录

```text
docs/
├─ README.md                  文档导航与维护规则
├─ guides/
│  ├─ quickstart.md           安装、启动、停止与排障
│  └─ experiments.md          实验配置、控制、参数查看与导出
├─ architecture/
│  └─ overview.md             模块、契约、执行、存储与模型边界
├─ development/
│  ├─ guide.md                开发环境、测试、契约与代码入口
│  └─ roadmap.md              当前完成状态与待开发能力
├─ quality/
│  └─ validation.md           本轮检查与历史验收证据
└─ releases/
   └─ changelog.md            版本变化与文档整理记录
```

## 信息来源与维护规则

| 内容 | 维护位置 |
|---|---|
| 核心字段与校验 | [后端领域契约](../apps/backend/drone_lab/domain.py) |
| JSON Schema 与前端类型 | [生成脚本](../scripts/generate_contracts.py)，产物见 [schemas](../schemas/) 和 [contracts.ts](../apps/web/src/contracts.ts) |
| API 请求与响应 | 运行服务后的 <http://127.0.0.1:8000/docs> |
| 当前实现与约束 | [工程架构](architecture/overview.md) |
| 尚未实现的功能 | [开发路线](development/roadmap.md) |
| 实际运行过的检查 | [验证记录](quality/validation.md) |
| 历史变化 | [变更记录](releases/changelog.md) |

1. 功能变化时更新对应主题，根 README 保持为简介与导航。
2. 当前架构只写当前实现；旧行为写入版本记录，计划写入开发路线。
3. 不手动修改生成的 Schema 与 TypeScript 契约。
4. 命令默认从项目根目录执行，链接采用仓库相对路径。
5. 验证记录标注日期、命令和范围，区分本轮结果与历史证据。
6. 示例放入 `examples/`，临时截图与测试数据库放入 `tmp/`，运行数据放入 `data/`。
7. 移动文档后修正链接，新增页面加入本导航。

项目总览见 [根 README](../README.md)。
