'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog } = require('electron');
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
let tray = null;
let isQuitting = false;

// ---- 设置读写 ----
const SETTINGS_FILE = path.join(paths.dshHome(), 'dsh-studio-settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { closeAction: 'ask' }; }
}

function saveSettings(settings) {
  fs.mkdirSync(paths.dshHome(), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// ---- 系统托盘 ----
function showTray() {
  if (tray) return;
  // 创建 16x16 蓝色方块图标
  const icon = nativeImage.createEmpty();
  // 用 createFromBuffer 创建简单图标
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[i] = 66;     // R
      buf[i + 1] = 133; // G
      buf[i + 2] = 244; // B
      buf[i + 3] = 255; // A
    }
  }
  const trayIcon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  tray = new Tray(trayIcon);
  tray.setToolTip('DSH Studio');
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DSH Studio', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]));
}

function removeTray() {
  if (tray) { tray.destroy(); tray = null; }
}

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
    minWidth: 800, minHeight: 600,
    resizable: true,
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
        {
          label: '退出方式',
          submenu: [
            { label: '每次询问', type: 'radio', checked: loadSettings().closeAction === 'ask', click: () => saveSettings({ closeAction: 'ask' }) },
            { label: '最小化到托盘', type: 'radio', checked: loadSettings().closeAction === 'tray', click: () => saveSettings({ closeAction: 'tray' }) },
            { label: '直接退出', type: 'radio', checked: loadSettings().closeAction === 'quit', click: () => saveSettings({ closeAction: 'quit' }) },
          ],
        },
        { type: 'separator' },
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
  mainWindow.on('close', async (e) => {
    if (isQuitting) return; // 已确认退出，直接关

    const settings = loadSettings();
    if (settings.closeAction === 'tray') {
      e.preventDefault();
      mainWindow.hide();
      showTray();
      return;
    }
    if (settings.closeAction === 'quit') {
      isQuitting = true;
      return;
    }

    // ask 模式：弹窗询问
    e.preventDefault();
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['最小化到托盘', '退出程序'],
      defaultId: 0,
      title: '关闭 DSH Studio',
      message: '关闭窗口后要怎么做？',
      detail: '选择"最小化到托盘"可以在后台保持运行',
      checkboxLabel: '记住我的选择',
      checkboxChecked: false,
    });
    if (checkboxChecked) {
      saveSettings({ closeAction: response === 1 ? 'quit' : 'tray' });
    }
    if (response === 1) {
      isQuitting = true;
      app.quit();
    } else {
      mainWindow.hide();
      showTray();
    }
  });
  mainWindow.on('closed', () => { removeTray(); mainWindow = null; });
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
    isQuitting = true;
    removeTray();
    if (serverChild) {
      e.preventDefault();
      await killTree(serverChild);
      serverChild = null;
      app.exit(0);
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
