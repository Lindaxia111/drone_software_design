# 开发指南

## 环境与入口

首次安装见 [安装与启动](../guides/quickstart.md)。使用标准 CPython 3.12+ 与 Node.js 20+。以下命令使用工作区已有的 `.runtime/python/python.exe`，新环境可替换为 `.venv/Scripts/python.exe`。

API 和 Worker 可在不同终端启动：

```powershell
./.runtime/python/python.exe -m uvicorn drone_lab.api:app --host 127.0.0.1 --port 8000
```

```powershell
./.runtime/python/python.exe -m drone_lab.worker
```

两个进程必须使用相同的工作目录和 `DRONE_LAB_DB`。前端热更新：

```powershell
Set-Location apps/web
npm run dev
```

前端默认代理到 `127.0.0.1:8000`，改 API 端口时同步调整 [Vite 配置](../../apps/web/vite.config.ts)。

## 数据契约与示例

先修改 [应用领域契约](../../apps/backend/drone_lab/domain.py)，再生成产物：

```powershell
./.runtime/python/python.exe scripts/generate_contracts.py
```

脚本生成 9 份 JSON Schema、前端 `contracts.ts` 和 3 份 JSON 示例。不要直接编辑生成文件。

`examples/experiment.json` 使用契约兼容默认值，是 demo/random 请求；动力学配置应显式指定 `evaluation_mode`、`optimizer` 及合理步长，也可取 `/api/defaults` 的工作台配置。

物理核心与应用契约不同，变更转换逻辑时同时检查 [适配层](../../apps/backend/drone_lab/core_adapter.py)。

## 测试与构建

```powershell
./.runtime/python/python.exe -m pytest -q
```

| 位置 | 覆盖范围 |
|---|---|
| [test_workflow.py](../../tests/test_workflow.py) | 预算、缓存、生命周期、恢复与 API |
| [test_core_integration.py](../../tests/test_core_integration.py) | 动力学、进化恢复、详情、暂停与兼容 |
| [tests/core](../../tests/core/) | 物理基准、故障、随机化、哈希、构型与参数工具 |
| [test_revisions.py](../../tests/test_revisions.py) | 衍生构型、历史不可变、编号、预算、暂停重评、归属和旧库迁移 |

当前 49 项测试均由根目录命令收集，无需依赖额外工程目录。

```powershell
Push-Location apps/web
npm run build
Pop-Location
```

构建包含 TypeScript 检查和 Vite 打包。

## 浏览器验收

在独立终端启动测试服务：

```powershell
$env:DRONE_LAB_DB = 'tmp/browser-check.sqlite3'
./scripts/dev.ps1 -Port 8020
```

另一个终端执行：

```powershell
$env:BASE_URL = 'http://127.0.0.1:8020'
node tests/browser-core.cjs
node tests/browser-smoke.cjs
node tests/browser-workbench.cjs
```

脚本使用本机 Chrome。Playwright 为可选验收工具，工作台运行不依赖它；新环境如需安装：

```powershell
npm install --prefix apps/web --no-save --package-lock=false @playwright/test@1.49.1
```

测试会创建实验记录，应使用独立测试数据库。截图和导出保存在 `tmp/core-screenshots/`、`tmp/screenshots/`、`tmp/workbench-screenshots/`。工作台测试使用软件 WebGL 验证模型、拆解、拾取、联动、草稿和重评。

## 变更检查

1. 物理行为或缓存产物变化时提升评估器版本。
2. 优化器变化时验证固定种子与跨进程恢复，避免仅依赖内存状态。
3. 修改公共契约后生成产物并构建前端。
4. 按改动运行相关测试，在 [验证记录](../quality/validation.md) 写明实际执行内容。
5. 当前实现更新 [工程架构](../architecture/overview.md)，未来工作更新 [路线](roadmap.md)，版本变化更新 [变更记录](../releases/changelog.md)。
