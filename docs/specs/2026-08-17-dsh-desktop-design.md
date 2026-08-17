# DSH Desktop 设计文档

- 日期：2026-08-17
- 状态：已获用户批准（2026-08-17）
- 项目目录：`C:\Users\lgswr\Desktop\dsh-desktop`

## 1. 背景与目标

DeepSeek Harness（dsh）官方形态是命令行启动的本地 Web 服务（`dsh web`，默认端口 3080），用户通过浏览器访问 GUI。本项目的目标：

1. 将 DSH 打包为**原生桌面应用**（Electron），独立窗口内嵌 GUI，不依赖浏览器
2. **自动管理 dsh 服务进程**：启动时拉起、退出时清理，用户无感
3. 生成**可分发的 NSIS 安装包**（.exe），目标用户无需安装 Node/CLI，首次运行通过向导配置 API Key
4. **与现有 CLI 安装无缝共存**：共享工作区/会话数据，无冲突
5. **预留官方 dsh 升级通道**：dsh 包自动更新，不落后于官方 Web 版

核心原则：**桌面版只是外壳（容器 + 管家），不修改、不裁剪 DSH 本身**。GUI 功能与官方 Web 版 100% 一致。

## 2. 架构总览

```
┌───────────────────────────────────────────────────┐
│  Electron 应用（主进程）                            │
│  ├─ main.js            生命周期编排                  │
│  ├─ server-manager.js  dsh 服务进程管理             │
│  ├─ port-probe.js      端口探测与实例连接           │
│  ├─ bootstrap.js       首次运行初始化               │
│  ├─ update-manager.js  dsh 包更新管理              │
│  └─ single-instance    单实例锁                    │
├───────────────────────────────────────────────────┤
│  渲染层（三个本地页面按状态切换）                    │
│  ├─ loading.html      服务启动等待页                │
│  ├─ setup.html        首次配置密钥向导页            │
│  ├─ error.html        错误页（含重试按钮）          │
│  └─ 内嵌 DSH GUI      http://127.0.0.1:<port>      │
└───────────────────────────────────────────────────┘
```

数据流：

1. 应用启动 → 单实例锁检查 → 端口探测
2. 按状态机推进：初始化（如需）→ 启动/连接服务 → 就绪探测 → 窗口加载 GUI
3. 服务子进程 stdout/stderr 汇入主进程日志；崩溃事件触发错误页

## 3. 组件设计

### 3.1 main.js（入口）

- 应用生命周期编排，调用下述模块
- 单实例锁：`app.requestSingleInstanceLock()`，二次启动时聚焦已有窗口
- 退出钩子：`before-quit` 中终止服务子进程树

### 3.2 port-probe.js（端口探测与连接）

启动流程第一步，向 `http://127.0.0.1:3080` 发就绪探测：

- **已有服务在跑**（HTTP 可达）→ 不启动新服务，直接内嵌连接现有实例。此时运行时状态（含正在运行的会话）与 CLI 浏览器完全一致
- **端口被占用但不可达**（其他程序占用，或另一个 dsh 实例正在启动）→ 短暂重试 5 秒；仍不可达 → 主动探测空闲端口，用该端口拉起新服务
- **无监听** → 由 server-manager 在默认端口拉起服务

### 3.3 server-manager.js（服务进程管理）

- 以 `ELECTRON_RUN_AS_NODE` 方式 spawn 捆绑的 dsh 包 `lib/bin.js`，参数 `--profile web --port <port>`（端口由 port-probe 决策）
- 就绪探测：轮询目标端口，HTTP 200 视为就绪；超时 30s → 错误页
- 退出清理：终止整个子进程树（dsh 可能派生子进程），`taskkill /T /F` 或 `tree-kill` 实现
- 崩溃处理：服务异常退出 → error.html（显示退出码/日志摘要）+「重试」按钮
- 日志：子进程输出写入应用用户数据目录 `logs/`

### 3.4 bootstrap.js（首次运行初始化）

目标机器没有 dsh 也没有配置，首次启动时：

1. 检测 `%USERPROFILE%\.dsh`；缺 `profiles/web` → 从应用资源目录（`extraResources`）复制骨架：`cordis.yml`、`cordis.patch.yml`、`package.json`、`pnpm-workspace.yaml`
2. 检测 `.credentials.yaml` 无 `DEEPSEEK_API_KEY` → 显示 setup.html 向导，用户粘贴 DeepSeek API Key，写入 `.credentials.yaml`（权限收紧）
3. 完成 → 进入启动流程

### 3.5 update-manager.js（dsh 包更新）

三层加载策略，解决官方 dsh 迭代（当前 0.1.0-rc.6）的升级问题：

```
启动时（同步，快速失败）:
  ① 优先加载 %USERPROFILE%\.dsh\vendor\dsh\ 下的副本（更新管理器下载的新版）
  ② 不存在则用安装包捆绑的版本（基线，离线可用）

启动后（异步，静默）:
  ③ 请求 npm registry 比对最新版本号
     ├─ 有新版 → 后台下载 tarball → 解压到 vendor 区 → 下次启动生效
     └─ 失败 → 忽略，继续用现有版本
```

- **坏版本防护**：vendor 区版本启动失败（spawn 报错/服务起不来）→ 自动回退捆绑基线
- **数据保护**：重装/升级外壳只覆盖安装目录，`~/.dsh`（配置、密钥、会话、vendor）永不触碰
- 版本信息显示：设置页/关于页展示当前 dsh 版本与可用版本

### 3.6 单实例锁

- Electron `requestSingleInstanceLock` 防桌面版双开
- 与 CLI 并发的极端竞态（同一秒两边同时拉起）：由 port-probe 探测兜底——后启动方探测到端口被占且不可达时提示"端口被占用，请关闭其他实例"，不强行抢端口

## 4. 与现有 CLI 的共存与冲突处理

| 共享资源 | 冲突情况 | 解决方案 |
|---|---|---|
| 端口 3080 | 同一时刻只能一个实例监听 | 启动前端口探测：已有服务 → 直接连接；被占用不可达 → 换随机端口；无监听 → 拉起 |
| `%USERPROFILE%\.dsh` | 双实例并发启动争写 `cordis.yml` | 探测后连接机制保证同时只有一个进程在启动；单实例锁防双开；极端竞态给出明确错误提示 |
| 工作区/会话数据 | —（天然共享） | 工作区注册表 `storages/workspace.json`、会话 `sessions/<工作区编码>/` 均为用户级持久化，任何实例读取同一份数据，**数据层完全通用** |
| 运行中会话 | 绑定具体服务进程 | 连接现有实例时可见运行中会话；自启新实例时历史会话从存储恢复，运行时从零开始 |

## 5. 密钥安全

- API Key 仅写入用户目录 `.dsh/.credentials.yaml`（与官方 CLI 相同位置，格式兼容，可互用）
- setup.html 向导：输入框不记录历史、无网络上报、提交即写盘
- 应用内不额外保存密钥副本

## 6. 打包与分发

- 工具：electron-builder + NSIS
- 应用名：**DeepSeek Harness Desktop**
- 安装包体积：约 100~150MB（含 Chromium 与 dsh 依赖）
- 目标平台：Windows x64（开发机同架构）
- 捆绑内容：Electron 运行时、应用外壳、`@deepseek-ai/dsh` 及其依赖（含原生模块 node-pty/sharp 等，按 win-x64 重编译）、profile 骨架模板（extraResources）
- 安装位置：`%LOCALAPPDATA%\Programs\dsh-desktop`（默认）
- 卸载：NSIS 标准卸载，不清除 `~/.dsh`

## 7. 错误处理矩阵

| 场景 | 表现 |
|---|---|
| 首次运行缺配置 | setup.html 向导 |
| 服务启动失败（spawn 错误） | error.html + 日志摘要 + 重试 |
| 就绪探测超时（30s） | error.html + 重试 |
| 服务运行中崩溃 | 错误事件 → error.html + 重试 |
| 端口被占且不可达 | 重试 5 秒 → 自动探测空闲端口启动 |
| vendor 版 dsh 启动失败 | 自动回退捆绑基线 |
| 更新下载失败 | 静默忽略，用现有版本 |

## 8. 测试策略

- **单元测试**：port-probe（mock http）、update-manager（mock registry）、bootstrap（mock 文件系统）逻辑
- **手动验收清单**：
  1. 全新环境模拟（临时清空 `~/.dsh`）：向导 → 密钥配置 → 启动 → GUI 加载
  2. 密钥已配置：直接启动
  3. CLI 实例运行中 → 桌面版直接连接（同一会话可见）
  4. 端口 3080 被其他程序占用 → 自动换端口
  5. 退出应用 → 服务进程树被清理（无残留）
  6. 服务崩溃（kill 子进程）→ 错误页 + 重试恢复
  7. 安装包安装/卸载；卸载后 `~/.dsh` 保留
  8. 双开桌面版 → 聚焦已有窗口
  9. 更新管理器：vendor 存在时优先加载；坏版本回退

## 9. 非目标（YAGNI）

- 不修改 dsh 源码，不新增 Web 版没有的功能
- 不做托盘常驻、开机自启（用户未要求）
- 不做 macOS/Linux 打包（用户未要求）
- 不内置模型配置管理（沿用 dsh 自身机制）

## 10. 里程碑

1. 脚手架：Electron 应用可运行，窗口加载本地 loading 页
2. 服务管理：端口探测 + 服务拉起 + 就绪加载 GUI + 退出清理
3. 首次运行向导 + bootstrap 初始化
4. 更新管理器 + vendor 三层加载
5. electron-builder 打包 + 手动验收清单执行
