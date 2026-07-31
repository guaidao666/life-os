# LifeOS · 人生管理系统工作台

一个跑在本地的个人人生管理系统：待办、饮食、运动、记账、读书、心情、烟火食记、项目、资料、英语、任务板、帮助、星愿清单、游戏化数值面板（愿力点 / 星愿点 / 契约 / 技能 / 境界）……单页面工作台 + 本地 SQLite 后端，零外部依赖。

## 技术栈
- 后端：Node 22 内置 `node:sqlite`（`DatabaseSync`），原生 `http`，零 npm 依赖
- 前端：单文件 `index.html`（含全部模块 UI）
- 数据库：SQLite（`life.db`，17 张表）
- 端口：`http://localhost:3000`

## 快速开始
需要 **Node 22+**（启动需 `--experimental-sqlite` 标志）。

```bash
# 方式一：直接跑
node --experimental-sqlite server.mjs

# 方式二：双击 start.bat（会自动打开浏览器 + 后台隐藏启动 server）
# 停止服务：双击 stop.vbs，或任务管理器结束 node.exe
```

浏览器打开 http://localhost:3000 即可。**首次运行会自动建空库并初始化玩家数值**，无需手动建表。

## ⚠️ 隐私说明（重要）
- `life.db` 和 `uploads/` **不进 Git 仓库**（见 `.gitignore`），里面是你的个人数据。
- 如需备份数据：请在本地把 `life.db` + `uploads/` 打成**加密压缩包**（如 7z 带密码）再存网盘，**不要**明文推到任何公开/私有仓库。
- GitHub 上的代码仓库只含程序，**不含你的任何隐私数据**。

## 隐藏启动（无黑框）
- `launch.vbs`：用 `WScript.Shell.Run(..., 0, False)` 在后台隐藏窗口启动 server
- `start.bat`：顺手开浏览器 + 调 `launch.vbs` + 立刻退出（不再常驻 cmd 黑框）
- `autostart.bat`：放进 Windows 启动文件夹 `...\Start Menu\Programs\Startup` 实现开机自启
- `stop.vbs`：双击即隐藏结束 server

> 注：`launch.vbs` 里写死了作者机器的 Node 路径（`C:\Users\WKS\.workbuddy\binaries\node\versions\22.22.2\node.exe`）。换机器请改成你自己的 Node 22 路径，或把 Node 加到 PATH 后改成 `node.exe`。

## 版本与恢复
里程碑用 **git tag** 存档（如 `v0.0.1`），不是 branch：
```bash
git tag v0.0.1
git push --tags
```
在 GitHub 的 Releases 页面可一键下载某个版本的源码。

代码崩溃恢复：
```bash
git clone <repo>
git checkout v0.0.1   # 或下载对应 Release 的 Source code
```
数据恢复：把备份的 `life.db` + `uploads/` 放回本目录即可。

## 目录结构
```
life-os/
├─ server.mjs        # 后端（node:sqlite，自动建表 + 提供 /api/* 接口）
├─ index.html        # 前端单文件工作台
├─ start.bat         # 启动器（开浏览器 + 隐藏起 server）
├─ launch.vbs        # 隐藏窗口启动 server
├─ stop.vbs          # 停止 server
├─ autostart.bat     # 开机自启用（复制到 Windows 启动文件夹）
├─ cook_add.mjs      # 命令行记一道菜（调用 /api/cook）
├─ parse_xlsx.py     # xlsx 解析（标准库，server 调用）
├─ .gitignore        # 已排除 life.db / uploads/ 等隐私
└─ README.md
```
