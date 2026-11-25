# 安装与启动

以下 PowerShell 命令均在项目根目录执行。

## 当前工作区

工作区已准备 `.runtime/python/python.exe` 与前后端依赖：

```powershell
./scripts/dev.ps1
```

脚本构建前端，启动独立 Worker 和 API。打开：

- 工作台：<http://127.0.0.1:8000>
- API 文档：<http://127.0.0.1:8000/docs>
- 健康检查：<http://127.0.0.1:8000/api/health>

已有前端构建时可执行 `./scripts/dev.ps1 -SkipBuild`。

## 新环境安装

需要标准 CPython 3.12+ 与 Node.js 20+。当前锁定的 NumPy/SciPy 要求 Python 3.12，MSYS Python 不适用于这些 Windows 二进制依赖。

```powershell
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.lock
./.venv/Scripts/python.exe -m pip install --no-deps -e '.[dev]'

Push-Location apps/web
npm ci
Pop-Location

./.venv/Scripts/python.exe scripts/generate_contracts.py
./scripts/dev.ps1
```

[启动脚本](../../scripts/dev.ps1) 优先使用 `.runtime/python/python.exe`，其次是 `.venv/Scripts/python.exe`，最后是 PATH 中的 `python`。环境目录不纳入源码。

## 停止、重启与数据

在启动终端按 Ctrl+C 停止。实验状态保存在 `data/drone_lab.sqlite3`；再次启动后继续处理等待或运行中的实验。手动暂停的实验保持暂停，需在页面启动或继续。

更新后端后重启 API 和 Worker；更新前端后重新构建并刷新页面。

## 更换端口或数据库

```powershell
./scripts/dev.ps1 -Port 8010
```

测试环境可以指定独立数据库：

```powershell
$env:DRONE_LAB_DB = 'tmp/manual-check.sqlite3'
./scripts/dev.ps1 -Port 8020
```

恢复默认数据库时，在同一终端执行 `Remove-Item Env:DRONE_LAB_DB`。

## 常见问题

| 现象 | 检查方式 |
|---|---|
| 缺少 Python 模块 | 使用启动脚本实际选择的解释器安装依赖 |
| 页面打不开 | 查看启动终端的构建或端口错误，确认实际使用端口 |
| 实验一直等待 | 检查 Worker 是否启动，API 与 Worker 是否使用相同数据库 |
| 提示已有 Worker | 关闭重复进程或为测试选择独立数据库 |
| 页面仍显示旧功能 | 停止旧服务，执行完整启动命令并刷新页面 |
| 暂停按钮不可用 | 完成、取消或已暂停时禁用，见 [运行控制](experiments.md#运行控制) |

下一步阅读 [实验操作指南](experiments.md)。
