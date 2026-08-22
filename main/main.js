'use strict';
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const paths = require('./paths');
const { decidePort } = require('./port-probe');
const { spawnDsh, waitReady, killTree } = require('./server-manager');
const { ensureProfile, readApiKey, writeApiKey } = require('./bootstrap');
const {
  getLatestVersion, isNewer, resolveDshEntry, performUpdate,
} = require('./update-manager');

const DSH_VERSION = '0.1.0-rc.6'; // 捆绑基线版本，与 vendor-src 一致

let mainWindow = null;
let serverChild = null;
let currentPort = 3080;
let booting = false;

function entryFor(projectRoot) {
  // 打包后基线位于 resources/dsh；开发模式位于项目 node_modules
  const baseline = app.isPackaged
    ? path.join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : paths.baselineDshEntry(projectRoot);
  const vendor = paths.vendorDshEntry();
  return resolveDshEntry({ vendorEntry: vendor, baselineEntry: baseline });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function stage(stage, detail) {
  send('app:stage', { stage, detail });
}

function fatal(message, detail) {
  send('app:fatal', { message, detail });
}

async function startDsh(projectRoot, { forcePort } = {}) {
  stage('port', '检查端口…');
  const decision = await decidePort(forcePort || 3080);
  currentPort = decision.port;
  if (decision.mode === 'connect') {
    stage('connect', `发现已有服务 (端口 ${currentPort})，直接连接…`);
    await loadGui(currentPort);
    return;
  }

  const dshHome = paths.dshHome();
  stage('init', '检查首次运行配置…');
  const created = await ensureProfile(dshHome);
  if (created) stage('init', '已初始化 profile 骨架');

  const apiKey = await readApiKey(dshHome);
  if (!apiKey) {
    loadSetupPage();
    return;
  }

  stage('vendor', '解析 dsh 版本…');
  const tryEntry = async (entry) => {
    serverChild = spawnDsh({
      entry, port: currentPort, dshHome,
      projectRoot, execPath: process.execPath,
    });
    const ready = await waitReady(currentPort, 20000);
    if (ready) {
      serverChild.on('exit', (code) => {
        if (booting || !mainWindow || mainWindow.isDestroyed()) return;
        fatal('dsh 服务已退出', `退出码 ${code}，请点击重试`);
      });
      return true;
    }
    await killTree(serverChild);
    serverChild = null;
    return false;
  };

  const vendorEntry = paths.vendorDshEntry();
  const baselineEntry = entryFor(projectRoot);
  const useVendor = vendorEntry && fs.existsSync(vendorEntry) && fs.existsSync(path.join(paths.vendorDir(), 'node_modules'));
  let ok = false;
  if (useVendor) {
    stage('start', `启动 dsh (vendor, 端口 ${currentPort})…`);
    ok = await tryEntry(vendorEntry);
    if (!ok) {
      stage('start', 'vendor 版本启动失败，回退基线…');
      ok = await tryEntry(baselineEntry);
    }
  } else {
    stage('start', `启动 dsh (基线, 端口 ${currentPort})…`);
    ok = await tryEntry(baselineEntry);
  }
  if (!ok) {
    fatal('服务启动失败', '请查看日志后重试');
    return;
  }
  await loadGui(currentPort);
}

async function loadGui(port) {
  stage('gui', '加载界面…');
  const win = mainWindow;
  await win.loadURL(`http://127.0.0.1:${port}/`);
  win.setTitle(`DSH Studio — 端口 ${port}`);
}

function loadSetupPage() {
  const win = mainWindow;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
}

async function boot() {
  if (booting) return;
  booting = true;
  try {
    const projectRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
    await startDsh(projectRoot);
    // 异步更新检查：不阻塞启动
    checkForUpdates().catch(() => {});
  } catch (e) {
    fatal('启动失败', String(e && e.stack || e));
  } finally {
    booting = false;
  }
}

async function checkForUpdates() {
  try {
    const remote = await getLatestVersion();
    if (!isNewer(remote, DSH_VERSION)) return;
    stage('update', `发现新版本 dsh ${remote}，后台更新中…`);
    const vendorRoot = paths.vendorDir();
    const npmCli = app.isPackaged
      ? path.join(process.resourcesPath, 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(__dirname, '..', 'vendor-src', 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await performUpdate(remote, { vendorDir: vendorRoot, npmCliPath: npmCli, execPath: process.execPath });
    stage('update', `dsh ${remote} 已就绪，下次启动生效`);
  } catch {
    // 静默失败，继续用现有版本
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const menuTemplate = [
    {
      label: '文件',
      submenu: [
        { label: '退出', role: 'quit', accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭', role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'loading.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    fatal('页面加载失败', `${code}: ${desc}`);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    createWindow();
    ipcMain.handle('setup:submit', async (_e, key) => {
      await writeApiKey(paths.dshHome(), key);
      boot();
    });
    ipcMain.handle('version:info', () => ({
      dshVersion: DSH_VERSION,
      appVersion: app.getVersion(),
    }));
    ipcMain.handle('app:retry', () => boot());
    const { ensureDshInstalled } = require('./bootstrap');
    await ensureDshInstalled(paths.dshHome());
    boot();
  });

  app.on('before-quit', async (e) => {
    if (serverChild) {
      e.preventDefault();
      await killTree(serverChild);
      serverChild = null;
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
