# DeepSeek Harness Desktop

DeepSeek Harness (dsh) 的原生桌面版外壳 —— 内嵌 GUI、自动管理服务进程、首次运行密钥向导、dsh 自动升级、NSIS 安装包分发。

## 功能

- 独立窗口内嵌 dsh GUI，不依赖浏览器
- 自动管理 dsh 服务进程（启动拉起、退出清理）
- 与现有 CLI 无缝共存（端口探测、数据共享）
- 首次运行向导配置 API Key
- dsh 自动更新（vendor 三层加载 + 坏版本回退）
- NSIS 安装包分发（Windows x64）

## 开发运行

```bash
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
# 准备捆绑（需要联网）
npm run bundle:dsh

# 打包安装包
npm run dist
```

生成 `dist/DeepSeek Harness Desktop Setup 0.1.0.exe`。

## 项目结构

```
├── main/                  # Electron 主进程
│   ├── main.js           # 入口，生命周期编排
│   ├── paths.js          # 路径解析
│   ├── port-probe.js     # 端口探测与决策
│   ├── server-manager.js # dsh 服务进程管理
│   ├── bootstrap.js      # 首次运行初始化
│   ├── update-manager.js # dsh 更新管理
│   └── preload.js        # 渲染进程桥
├── renderer/             # 渲染层页面
│   ├── loading.html      # 启动等待页
│   ├── setup.html        # 密钥配置向导
│   ├── error.html        # 错误页
│   └── theme.css         # 共用样式
├── scripts/              # 构建脚本
├── test/                 # 单元测试
├── docs/                 # 设计文档与计划
└── vendor-src/           # dsh 捆绑源
```

## 设计文档

- [设计文档](docs/specs/2026-08-17-dsh-desktop-design.md)
- [实施计划](docs/superpowers/plans/2026-08-17-dsh-desktop.md)

## 许可

私有项目。
