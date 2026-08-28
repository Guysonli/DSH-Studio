# DSH Studio

DeepSeek Harness (dsh) 的原生桌面版外壳 —— 内嵌图形界面、自动管理服务进程、首次运行密钥向导、dsh 自动升级、NSIS 安装包分发。

![License](https://img.shields.io/badge/license-GPL%20v3-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)

## 功能

- 独立窗口内嵌 dsh 图形界面，不依赖浏览器（`--no-open`，不额外弹系统浏览器）
- 自动管理 dsh 服务进程（启动拉起、退出清理）
- **与 dsh 原生环境共用数据**：密钥/会话/工作区同一份 `~/.dsh`、凭据文件与官方命令行完全互认（原生 v1 格式）；已有服务可连接复用或启动独立实例
- 首次运行向导配置 API Key（写入格式与官方命令行完全一致）
- dsh 自动更新（自更新副本 → 捆绑基线；均不可用时提供安装选择页）
- 首次启动自动下载 dsh
- NSIS 安装包分发（Windows x64）

## 安装

从 [Releases](https://github.com/Guysonli/DSH-Studio/releases) 下载最新安装包，双击安装。

## 开发

```bash
# 克隆仓库
git clone https://github.com/Guysonli/DSH-Studio.git
cd dsh-studio

# 安装依赖
npm install

# 开发模式运行
npm start
```

## 测试

```bash
npm test
```

## 图标

桌面/托盘图标由 `scripts/make-icons.ps1` 程序化生成（方案 D：亮蓝渐变 + 白色 D 形对话气泡），产出 `icons/icon.ico`（16~256 多尺寸）、`icons/tray.png`、设计稿预览 `icons/preview/`：

```bash
pwsh scripts/make-icons.ps1
```

## 打包

```bash
# 准备捆绑 dsh（需要联网）
npm run bundle:dsh

# 打包 NSIS 安装包（dist 前会自动检查捆绑资源是否就绪；
# 未就绪时请改用一键流程 npm run dist:full）
npm run dist
```

生成 `dist/DSH Studio Setup 0.1.0.exe`。**注意**：直接运行 `npm run dist` 而未先执行 `bundle:dsh` 会产出没有 dsh 基线的安装包，`scripts/check-bundle.js` 会在打包前拦截并提示。

## 工作原理

```
┌─────────────────────────────────┐
│         DSH Studio (壳)         │
│  Electron 外壳 + 界面管理       │
├─────────────────────────────────┤
│         dsh (核)                │
│  DeepSeek Harness 命令行        │
│  AI 功能 + 工具 + 插件          │
└─────────────────────────────────┘
```

- **壳**：本项目，负责窗口管理、进程管理、自动更新
- **核**：[dsh](https://github.com/deepseek-ai/deepseek-harness)，负责 AI 功能
- 壳和核分离，核升级时壳通常不需要修改

## 一个服务，多个入口

你真正需要的只是一份数据（`~/.dsh`：密钥/会话/工作区）加一个运行中的 dsh 服务。窗口、浏览器、终端只是三个入口，访问的是同一个服务：

- **Studio 窗口**：内嵌图形界面（启动器的默认入口）
- **浏览器**：直接打开 `http://127.0.0.1:<端口>` 即可使用原生网页界面，**无需任何额外安装**
- **终端命令行**：`dsh` 命令（无头 / 文本界面 / 脚本）——只有需要命令行体验时才需全局安装，可选

### dsh 来源与共存原则

**Studio 只对它自己的 dsh 负责**，与其他途径安装的 dsh（npm / npx / Volta）彼此完全独立：安装不互相覆盖、卸载互不影响、版本各自管理，唯一共享的是 `~/.dsh` 数据（密钥/会话/工作区全部互通）。

```
启动用哪个（Studio 自己的，完全独立）：
  ① 自更新副本（~/.dsh/vendor/dsh） → Studio 托管的更新通道
  ② 捆绑基线（安装包自带）          → 离线兜底，开箱即用
  ③ 两者都不可用 → 选择页列出电脑上所有完整 dsh 安装，由你挑选（仅本次生效）

端口冲突怎么处理：
  · 3080 空闲            → 启动 Studio 自己的实例
  · 3080 已有 dsh 服务   → 第一次询问：「建立连接（共享运行中会话）」或「启动独立实例（换空闲端口）」，可记住选择
  · 非 dsh 程序占用      → 自动换空闲端口
```

- **数据互通**：无论谁启动（命令行/浏览器/Studio/npx），读写的是同一份 `~/.dsh`；卸载任何一方都不影响其余方。
- **互不干扰**：Studio 绝不修改/删除/覆盖其他安装；其他安装卸载后 Studio 最多在必要时通过选择页换用来源。

## 项目结构

```
├── main/                  # Electron 主进程
│   ├── main.js           # 入口，生命周期编排
│   ├── paths.js          # 路径解析
│   ├── port-probe.js     # 端口探测与决策
│   ├── server-manager.js # dsh 服务进程管理
│   ├── bootstrap.js      # 首次运行初始化 + 自动下载
│   ├── update-manager.js # dsh 更新管理
│   └── preload.js        # 渲染进程桥
├── renderer/             # 渲染层页面
├── scripts/              # 构建脚本
├── test/                 # 单元测试
└── docs/                 # 设计文档与计划
```

## 相关链接

- [设计文档](docs/specs/2026-08-17-dsh-desktop-design.md)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 许可

[GNU General Public License v3.0](LICENSE)
