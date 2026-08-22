# DSH Studio

DeepSeek Harness (dsh) 的原生桌面版外壳 —— 内嵌 GUI、自动管理服务进程、首次运行密钥向导、dsh 自动升级、NSIS 安装包分发。

![License](https://img.shields.io/badge/license-GPL%20v3-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)

## 功能

- 独立窗口内嵌 dsh GUI，不依赖浏览器
- 自动管理 dsh 服务进程（启动拉起、退出清理）
- 与现有 CLI 无缝共存（端口探测、数据共享）
- 首次运行向导配置 API Key
- dsh 自动更新（vendor 三层加载 + 坏版本回退）
- 首次启动自动下载 dsh
- NSIS 安装包分发（Windows x64）

## 安装

从 [Releases](https://github.com/lgswr/dsh-studio/releases) 下载最新安装包，双击安装。

## 开发

```bash
# 克隆仓库
git clone https://github.com/lgswr/dsh-studio.git
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

## 打包

```bash
# 准备捆绑 dsh（需要联网）
npm run bundle:dsh

# 打包 NSIS 安装包
npm run dist
```

生成 `dist/DSH Studio Setup 0.1.0.exe`。

## 工作原理

```
┌─────────────────────────────────┐
│         DSH Studio (壳)         │
│  Electron 外壳 + GUI 管理       │
├─────────────────────────────────┤
│         dsh (核)                │
│  DeepSeek Harness CLI           │
│  AI 功能 + 工具 + 插件          │
└─────────────────────────────────┘
```

- **壳**：本项目，负责窗口管理、进程管理、自动更新
- **核**：[dsh](https://github.com/deepseek-ai/deepseek-harness)，负责 AI 功能
- 壳和核分离，核升级时壳通常不需要修改

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
- [实施计划](docs/superpowers/plans/2026-08-17-dsh-desktop.md)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 许可

[GNU General Public License v3.0](LICENSE)
