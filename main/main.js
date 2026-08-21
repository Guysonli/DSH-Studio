'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const paths = require('./paths');
const { decidePort } = require('./port-probe');
const { spawnDsh, waitReady, killTree } = require('./server-manager');
const { ensureProfile, readApiKey, writeApiKey } = require('./bootstrap');
const {
  getLatestVersion, isNewer, resolveDshEntry, downloadTarball, extractTarball,
} = require('./update-manager');

const DSH_VERSION = '0.1.0-rc.6'; // 捆绑基线版本，与 vendor-src 一致

let mainWindow = null;
let serverChild = null;
let currentPort = 3080;
let booting = false;
let lastDshEntry = null;

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
  lastDshEntry = entryFor(projectRoot);
  stage('start', `启动 dsh 服务 (端口 ${currentPort})…`);
  serverChild = spawnDsh({
    entry: lastDshEntry, port: currentPort, dshHome,
    projectRoot, execPath: process.execPath,
  });
  serverChild.on('exit', (code) => {
    if (booting || !mainWindow || mainWindow.isDestroyed()) return;
    fatal('dsh 服务已退出', `退出码 ${code}，请点击重试`);
  });
  const ready = await waitReady(currentPort, 30000);
  if (!ready) {
    fatal('服务启动超时', '30 秒内未就绪，请点击重试');
    return;
  }
  await loadGui(currentPort);
}

async function loadGui(port) {
  stage('gui', '加载界面…');
  const win = mainWindow;
  await win.loadURL(`http://127.0.0.1:${port}/`);
  win.setTitle(`DeepSeek Harness Desktop — 端口 ${port}`);
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
    const tgz = path.join(paths.dshHome(), 'vendor', `dsh-${remote}.tgz`);
    await downloadTarball(remote, tgz);
    await extractTarball(tgz, vendorRoot);
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

  app.whenReady().then(() => {
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
