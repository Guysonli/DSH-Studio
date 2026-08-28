'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const paths = require('./paths');
const { decidePort, probePort } = require('./port-probe');
const { spawnDsh, waitReady, killTree } = require('./server-manager');
const hostLock = require('./host-lock');
const { ensureProfile, readApiKey, writeApiKey } = require('./bootstrap');
const {
  getLatestVersion, isNewer, performUpdate,
} = require('./update-manager');

const DSH_VERSION = '0.1.1-rc.2'; // 捆绑基线版本，与 vendor-src 一致

let mainWindow = null;
let serverChild = null;
let currentPort = 3080;
let booting = false;
let tray = null;
let isQuitting = false;
let chosenEntry = null; // 用户从兜底页选定的 dsh 安装（仅本次启动生效）
let currentMode = null; // 'connect' 连接现有服务 | 'own' 本机独立实例
let currentEntry = null; // 本次启动使用的 dsh 安装路径（连接模式为 null）
let hostLockPid = null; // 单写者锁持有的 dsh 子进程 pid（own 模式且持锁时）

// ---- 设置读写 ----
const SETTINGS_FILE = path.join(paths.dshHome(), 'dsh-studio-settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { closeAction: 'ask', windowBounds: null }; }
}

function saveSettings(settings) {
  fs.mkdirSync(paths.dshHome(), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// ---- 系统托盘 ----
function trayIconImage() {
  // 优先使用正式设计的托盘图标（icons/tray.png，随包分发）
  try {
    const p = path.join(__dirname, '..', 'icons', 'tray.png');
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  } catch { /* 回退内置方块 */ }
  // 兜底：16x16 蓝色方块
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
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function showTray() {
  if (tray) return;
  const trayIcon = trayIconImage();
  tray = new Tray(trayIcon);
  tray.setToolTip('DSH Studio');
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DSH Studio', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: '在浏览器中打开', accelerator: 'CmdOrCtrl+Shift+O', click: () => { openInBrowser().catch(() => {}); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]));
}

function removeTray() {
  if (tray) { tray.destroy(); tray = null; }
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

/** 最近的服务日志尾部，用于错误页诊断。 */
function logTail(maxLines = 25) {
  try {
    const file = path.join(paths.logsDir(), 'server.log');
    if (!fs.existsSync(file)) return '（暂无日志）';
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '（无法读取日志）';
  }
}

/** 给启动条目一个可读标签。 */
function entryLabel(entry) {
  if (!entry) return '未知';
  const norm = entry.split(path.sep).join('/');
  if (norm.includes('/.dsh/vendor/dsh/') || norm.includes('/vendor/dsh/')) return '自更新副本';
  if (norm.includes('/Volta/') || norm.includes('/npm/node_modules/')) return '全局安装';
  if (norm.includes('/node_modules/@deepseek-ai/dsh/')) return '捆绑基线';
  return path.basename(path.dirname(path.dirname(entry)));
}

/** npm-cli 路径：打包版在 resources/tools，开发版在 vendor-src/tools。 */
function npmCliPathFor() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(__dirname, '..', 'vendor-src', 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** 捆绑基线根目录：打包版在 resources/dsh（extraResources），开发版在 vendor-src/dsh（bundle:dsh 产物）。 */
function bundleRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh')
    : path.join(__dirname, '..', 'vendor-src', 'dsh');
}

/** 在系统浏览器中打开当前 dsh 服务（菜单 / 托盘 / 快捷键共用）。 */
async function openInBrowser() {
  const port = currentPort || 3080;
  const up = await probePort(port, 1000);
  if (!up) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'DSH Studio',
      message: 'dsh 服务尚未运行',
      detail: '请等待服务启动完成后再试。',
    });
    return;
  }
  shell.openExternal(`http://127.0.0.1:${port}/`).catch(() => {});
}

/** 端口策略：连接已有服务 / 启动独立实例（未设置时询问一次并记住）。 */
function portPolicy() {
  return loadSettings().portPolicy; // 'connect' | 'own' | undefined
}

function savePortPolicy(policy) {
  const s = loadSettings();
  if (policy === undefined) delete s.portPolicy; // 改回"每次询问"
  else s.portPolicy = policy;
  saveSettings(s);
}

async function askPortPolicy() {
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['建立连接 (推荐)', '启动独立实例'],
    defaultId: 0,
    title: '检测到已有 dsh 服务',
    message: '端口 3080 已有一个 dsh 服务在运行，如何连接？',
    detail: '建立连接：复用现有服务（零额外进程，共享运行中会话）；' +
      '独立实例：在空闲端口启动 Studio 自己的 dsh（版本由 Studio 管理）。',
    checkboxLabel: '记住我的选择',
    checkboxChecked: false,
  });
  const policy = response === 0 ? 'connect' : 'own';
  if (checkboxChecked) savePortPolicy(policy);
  return policy;
}

// ---- 单写者保护（own 模式）：dsh 只有进程内单写者模型，两个宿主进程同写一个会话根
//      会产生 seq 重复（"corrupt session log: seq gap in committed region"）。
//      锁文件 ~/.dsh/dsh-host.lock 记录负责写入的 dsh 子进程 pid，见 main/host-lock.js。----
function releaseHostLock() {
  if (hostLockPid !== null) {
    hostLock.release(paths.dshHome(), hostLockPid);
    hostLockPid = null;
  }
}

/** 只读探测：另一活跃宿主是否存在（不动锁文件）。 */
function hostLockProbe() {
  const holder = hostLock.readLock(paths.dshHome());
  if (holder === null || holder.pid === undefined) return null;
  return hostLock.isAlivePid(holder.pid) ? holder : null;
}

/**
 * 处理"已存在另一活跃宿主"的冲突。
 * @returns 'connect' 复用 3080 现有服务 | 'proceed' 用户坚持启动（不持锁） | 'refuse' 取消
 */
async function handleWriterConflict(holder) {
  const occupied = await probePort(3080, 1500);
  if (occupied) {
    stage('connect', `检测到另一 dsh 服务（PID ${holder.pid}）正在运行，复用 3080 端口服务…`);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '改为连接现有服务',
      message: '检测到另一个 dsh 实例正在运行',
      detail: `为避免两个实例同时写入同一份会话数据（会损坏会话日志），` +
        `Studio 已改为连接现有服务（PID ${holder.pid}${holder.port ? `，端口 ${holder.port}` : ''}）。`,
    }).catch(() => {});
    return 'connect';
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['取消启动', '仍然启动（不推荐）'],
    defaultId: 0,
    cancelId: 0,
    title: '检测到另一个 dsh 实例',
    message: `另一个 dsh 服务正在运行（PID ${holder.pid}${holder.port ? `，端口 ${holder.port}` : ''}），` +
      '但 3080 端口没有它的服务。',
    detail: '两个 dsh 实例同时写同一份会话数据会损坏会话日志（seq 重复）。\n' +
      '建议取消启动：先关闭该实例，或直接在浏览器中使用它。\n' +
      '若你确认它已经停止（陈旧锁），选择"仍然启动"即可覆盖旧锁。',
  });
  return response === 1 ? 'proceed' : 'refuse';
}

/**
 * own 模式下 3080 被非本 Studio 的宿主（如 CLI 起的 dsh）占用时：明确提示双实例风险。
 * @returns 'connect' 连接现有服务 | 'proceed' 仍启动独立实例 | 'refuse' 取消
 */
async function confirmOwnConflict() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['连接现有服务（推荐）', '仍启动独立实例', '取消启动'],
    defaultId: 0,
    cancelId: 2,
    title: '检测到已有 dsh 服务（双实例风险）',
    message: '端口 3080 已有一个 dsh 服务在运行',
    detail: '两个实例并存时：会话列表不会实时同步（需切换工作区并刷新），' +
      '且同一会话并发写入可能损坏会话日志。\n' +
      '推荐「连接现有服务」——Studio 窗口与浏览器指向同一个实例，数据完全一致。',
  });
  if (response === 0) return 'connect';
  if (response === 2) return 'refuse';
  return 'proceed';
}

async function startDsh({ forcePort, chosenEntry } = {}) {
  const dshHome = paths.dshHome();
  // 每次启动重置运行状态（重试/重启后关于窗口与标题反映最新状态）
  currentMode = null;
  currentEntry = null;

  stage('init', '检查首次运行配置…');
  const created = await ensureProfile(dshHome);
  if (created) stage('init', '已初始化 profile 骨架');

  const apiKey = await readApiKey(dshHome);
  if (!apiKey) {
    loadSetupPage();
    return;
  }

  // ---- 端口策略：与已有实例透明协调，绝不硬碰 ----
  stage('port', '检查端口…');
  const defaultPort = forcePort || 3080;
  const occupied = await probePort(defaultPort, 1500);
  if (occupied) {
    let policy = portPolicy();
    if (!policy) policy = await askPortPolicy();
    if (policy === 'connect') {
      stage('connect', `发现已有 dsh 服务 (端口 ${defaultPort})，直接连接…`);
      currentPort = defaultPort;
      currentMode = 'connect';
      currentEntry = null;
      await loadGui(currentPort);
      return;
    }
    // own：3080 已被非本 Studio 的宿主（如 CLI）占用——明确提示双实例风险
    const keep = await confirmOwnConflict();
    if (keep === 'connect') {
      stage('connect', `发现已有 dsh 服务 (端口 ${defaultPort})，直接连接…`);
      currentPort = defaultPort;
      currentMode = 'connect';
      currentEntry = null;
      await loadGui(currentPort);
      return;
    }
    if (keep === 'refuse') {
      fatal('启动已取消',
        `端口 ${defaultPort} 已有一个 dsh 服务在运行。为避免双实例并存，本次未启动。\n` +
        '请改用「连接现有服务」，或关闭该实例后重试。');
      return;
    }
    // proceed：用户明确选择独立实例，继续（单写者锁保护随后生效）
  }
  const decision = await decidePort(defaultPort, { allowConnect: false });
  currentPort = decision.port;

  // ---- 单写者保护：own 模式会向 ~/.dsh 写入会话，必须先确认没有其他活跃宿主，
  //      否则两个宿主进程交错写同一会话会产生 seq 重复，损坏会话日志 ----
  let ownLocked = true; // false = 用户坚持启动（不持锁，风险自负）
  const aliveHolder = hostLockProbe();
  if (aliveHolder !== null) {
    const conflict = await handleWriterConflict(aliveHolder);
    if (conflict === 'connect') {
      currentPort = 3080;
      currentMode = 'connect';
      currentEntry = null;
      await loadGui(currentPort);
      return;
    }
    if (conflict === 'refuse') {
      stage('fatal', '已取消启动：检测到另一 dsh 实例在运行');
      fatal('启动已取消',
        '检测到另一个 dsh 实例正在运行（PID ' + aliveHolder.pid + '）。\n' +
        '为避免双写损坏会话日志，本次未启动。请关闭该实例后重试，或改用"连接现有服务"模式。');
      return;
    }
    ownLocked = false; // proceed：启动但不持锁
  }

  // ---- 使用哪个 dsh 安装 ----
  stage('vendor', '解析 dsh 安装…');
  let entries;
  if (chosenEntry) {
    entries = [chosenEntry]; // 用户从兜底页选定
  } else {
    entries = paths.resolveDshEntryPaths(bundleRoot()); // 独立：自更新副本 → 捆绑基线
  }
  if (entries.length === 0) {
    const all = paths.listAllDshEntries(bundleRoot());
    if (all.length === 0) {
      fatal('没有可用的 dsh 安装', 'Studio 自带的 dsh 不可用，且电脑上没有其他完整安装。\n\n日志尾部：\n' + logTail());
    } else {
      loadChooserPage(all);
    }
    return;
  }

  const tryEntry = async (entry) => {
    serverChild = spawnDsh({
      entry, port: currentPort, dshHome,
      projectRoot: bundleRoot(), execPath: process.execPath,
    });
    const child = serverChild;

    // 快速失败：就绪、子进程提前退出、spawn 错误三者竞速，
    // 避免 spawn 立即失败时干等 20 秒超时
    const outcome = await Promise.race([
      waitReady(currentPort, 20000).then((ok) => ({ ok })),
      new Promise((resolve) => child.once('exit', (code) => resolve({ ok: false, code }))),
      new Promise((resolve) => child.once('spawn-error', (err) => resolve({ ok: false, spawnError: err.message }))),
    ]);

    if (outcome.ok) {
      child.on('exit', (code) => {
        releaseHostLock(); // 子进程退出即释放单写者锁（若由本进程持有）
        if (booting || !mainWindow || mainWindow.isDestroyed()) return;
        fatal('dsh 服务已退出', `退出码 ${code}\n\n日志尾部：\n${logTail()}`);
      });
      return true;
    }
    const why = outcome.spawnError
      ? `启动错误：${outcome.spawnError}`
      : `进程提前退出（退出码 ${outcome.code}` + (outcome.code == null ? '，就绪超时' : '') + '）';
    console.warn(`[dsh-studio] ${why} —— ${entry}`);
    await killTree(child);
    if (serverChild === child) serverChild = null;
    return false;
  };

  const tryAllEntries = async () => {
    for (const entry of entries) {
      stage('start', `启动 dsh (${entryLabel(entry)}, 端口 ${currentPort})…`);
      const okEntry = await tryEntry(entry);
      if (okEntry) {
        currentMode = 'own';
        currentEntry = entry;
        return true;
      }
    }
    return false;
  };

  // ---- 启动 + 获取单写者锁 ----
  let ok = await tryAllEntries();
  if (!ok) {
    fatal('服务启动失败', '可用的 dsh 安装均未启动成功。请查看日志后重试。\n\n日志尾部：\n' + logTail());
    return;
  }
  if (ownLocked) {
    const locked = hostLock.acquire(dshHome, {
      pid: serverChild.pid,
      port: currentPort,
      entry: currentEntry,
      app: 'dsh-studio',
    });
    if (!locked.ok) {
      // 探测后仍被抢占（另一宿主恰好同时启动）：放弃本次子进程并重新处理冲突
      await killTree(serverChild);
      serverChild = null;
      const conflict = await handleWriterConflict(locked.holder);
      if (conflict === 'connect') {
        currentPort = 3080;
        currentMode = 'connect';
        currentEntry = null;
        await loadGui(currentPort);
        return;
      }
      if (conflict === 'refuse') {
        stage('fatal', '已取消启动：另一 dsh 实例抢占');
        fatal('启动已取消', '另一 dsh 实例抢先启动（PID ' + locked.holder.pid + '），为避免双写损坏会话日志，本次未启动。');
        return;
      }
      // proceed：无锁重试一次
      ok = await tryAllEntries();
      if (!ok) {
        fatal('服务启动失败', '可用的 dsh 安装均未启动成功。请查看日志后重试。\n\n日志尾部：\n' + logTail());
        return;
      }
    }
    hostLockPid = serverChild.pid;
  }
  await loadGui(currentPort);
}

async function loadGui(port) {
  stage('gui', '加载界面…');
  const win = mainWindow;
  await win.loadURL(`http://127.0.0.1:${port}/`);
  const modeMark = currentMode === 'connect' ? '（已连接现有服务）' : '';
  win.setTitle(`DSH Studio — 端口 ${port}${modeMark}`);
}

/** 关于对话框：多实例架构下的版本/来源/端口/数据目录透明度。 */
function showAbout() {
  const dshVer = currentEntry
    ? (paths.dshVersionOf(currentEntry) || '未知版本')
    : '（现有服务，由对方实例决定）';
  const modeText = currentMode === 'connect' ? '已连接现有服务' : '本机独立实例';
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 DSH Studio',
    message: `DSH Studio ${app.getVersion()}`,
    detail: [
      `dsh 版本：${dshVer}`,
      `服务：${modeText}（端口 ${currentPort}）`,
      `数据目录：${paths.dshHome()}`,
      `日志目录：${paths.logsDir()}`,
    ].join('\n'),
  });
}

function loadSetupPage() {
  const win = mainWindow;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
}

/** Studio 自带 dsh 不可用时：列出全部可用安装，由用户挑选（仅本次启动生效）。 */
function loadChooserPage(entries) {
  const win = mainWindow;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'chooser.html'), {
    query: { count: String(entries.length) },
  });
}

/** 兜底页候选列表（渲染层通过 dsh:choices 获取）。 */
function dshChoices() {
  return paths.listAllDshEntries(bundleRoot()).map((entry) => ({
    entry,
    label: entryLabel(entry),
    version: paths.dshVersionOf(entry) || '未知版本',
  }));
}

async function boot() {
  if (booting) return;
  booting = true;
  try {
    await startDsh({ chosenEntry });
    chosenEntry = null; // 仅本次启动生效
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
    // 优先与原生 CLI 共用：已存在完整全局安装时，版本管理交给用户的
    // CLI 工具（Volta / npm），Studio 不碰也不冗余下载另一份。
    if (paths.globalDshEntry()) return;
    const remote = await getLatestVersion();
    if (!isNewer(remote, DSH_VERSION)) return;
    stage('update', `发现新版本 dsh ${remote}，后台更新中…`);
    const vendorRoot = paths.vendorDir();
    await performUpdate(remote, {
      vendorDir: vendorRoot,
      npmCliPath: npmCliPathFor(),
      execPath: process.execPath,
    });
    stage('update', `dsh ${remote} 已就绪，下次启动生效`);
  } catch {
    // 静默失败，继续用现有版本
  }
}

function createWindow() {
  const settings = loadSettings();
  const bounds = settings.windowBounds || { width: 1280, height: 800 };

  mainWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width || 1280, height: bounds.height || 800,
    minWidth: 800, minHeight: 600,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 记住窗口大小和位置
  let resizeTimer;
  const saveBounds = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const s = loadSettings();
        s.windowBounds = mainWindow.getBounds();
        saveSettings(s);
      }
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  const menuTemplate = [
    {
      label: '文件',
      submenu: [
        { label: '在浏览器中打开', accelerator: 'CmdOrCtrl+Shift+O', click: () => { openInBrowser().catch(() => {}); } },
        { type: 'separator' },
        {
          label: '退出方式',
          submenu: [
            { label: '每次询问', type: 'radio', checked: loadSettings().closeAction === 'ask', click: () => saveSettings({ closeAction: 'ask' }) },
            { label: '最小化到托盘', type: 'radio', checked: loadSettings().closeAction === 'tray', click: () => saveSettings({ closeAction: 'tray' }) },
            { label: '直接退出', type: 'radio', checked: loadSettings().closeAction === 'quit', click: () => saveSettings({ closeAction: 'quit' }) },
          ],
        },
        {
          label: '端口策略',
          submenu: [
            { label: '每次询问', type: 'radio', checked: portPolicy() === undefined, click: () => savePortPolicy(undefined) },
            { label: '连接已有服务', type: 'radio', checked: portPolicy() === 'connect', click: () => savePortPolicy('connect') },
            { label: '启动独立实例', type: 'radio', checked: portPolicy() === 'own', click: () => savePortPolicy('own') },
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
    {
      label: '帮助',
      submenu: [
        { label: '关于 DSH Studio', click: () => showAbout() },
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
    showTray(); // 启动时显示托盘
    ipcMain.handle('setup:submit', async (_e, key) => {
      await writeApiKey(paths.dshHome(), key);
      boot();
    });
    ipcMain.handle('version:info', () => ({
      dshVersion: DSH_VERSION,
      appVersion: app.getVersion(),
    }));
    ipcMain.handle('app:retry', () => boot());
    ipcMain.handle('dsh:choices', () => dshChoices());
    ipcMain.handle('dsh:select', (_e, entry) => {
      chosenEntry = typeof entry === 'string' ? entry : null;
      boot();
    });
    // vendor 自更新副本的准备/修复可能耗时（npm install），放在后台执行，
    // 不阻塞启动：启动会先用当时可用的安装（自更新副本或捆绑基线）
    const { ensureDshInstalled } = require('./bootstrap');
    ensureDshInstalled(paths.dshHome(), {
      npmCliPath: npmCliPathFor(),
      execPath: process.execPath,
    }).catch(() => {});
    boot();
  });

  app.on('before-quit', async (e) => {
    isQuitting = true;
    removeTray();
    if (serverChild) {
      e.preventDefault();
      await killTree(serverChild);
      serverChild = null;
      releaseHostLock();
      app.exit(0);
    } else {
      releaseHostLock();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
