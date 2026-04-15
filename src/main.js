const { app, BrowserWindow, Notification, Menu, Tray, ipcMain, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let pollTimer = null;
let updaterInitialCheckTimer = null;
let updaterIntervalTimer = null;
let updaterConfigured = false;
let updaterCheckInFlight = false;
let updaterInstallInProgress = false;
let updateAvailable = false;
let isQuitting = false;
let lastSnapshot = new Map();
let lastConnectionState = 'unknown';
let lastConnectionErrorNotificationAt = 0;
let eventLog = [];

const APP_USER_MODEL_ID = 'com.mirkotagliente.technotify';
const UPDATER_INITIAL_DELAY_MS = 5000;
const UPDATER_POLL_INTERVAL_MS = 10 * 60 * 1000;
const NOC_REQUEST_TIMEOUT_MS = 12_000;
const CONNECTION_ERROR_REPEAT_MS = 15 * 60 * 1000;
const MAX_EVENT_LOG_ITEMS = 80;
const DEFAULT_CONFIG = {
  nocHost: '',
  nocPort: 8080,
  username: '',
  password: '',
  technicianName: '',
  pollIntervalSeconds: 60,
};

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

function configFile() {
  return path.join(app.getPath('userData'), 'technician-config.json');
}

function stateFile() {
  return path.join(app.getPath('userData'), 'technician-notification-state.json');
}

function logFile() {
  return path.join(app.getPath('userData'), 'tech-notify-log.json');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function normalizeConfig(payload = {}) {
  return {
    nocHost: String(payload.nocHost || '').trim(),
    nocPort: Number(payload.nocPort || DEFAULT_CONFIG.nocPort),
    username: String(payload.username || '').trim(),
    password: String(payload.password || ''),
    technicianName: String(payload.technicianName || '').trim(),
    pollIntervalSeconds: Math.max(30, Number(payload.pollIntervalSeconds || DEFAULT_CONFIG.pollIntervalSeconds)),
  };
}

function loadConfig() {
  return normalizeConfig({
    ...DEFAULT_CONFIG,
    ...readJson(configFile(), {}),
  });
}

function saveConfig(payload) {
  const config = normalizeConfig(payload);
  writeJson(configFile(), config);
  return {
    ...config,
    configPath: configFile(),
  };
}

function loadSnapshot() {
  const items = readJson(stateFile(), []);
  if (!Array.isArray(items)) return new Map();
  return new Map(items.filter((item) => item?.id).map((item) => [String(item.id), item]));
}

function saveSnapshot(snapshot) {
  writeJson(stateFile(), [...snapshot.values()]);
}

function loadEventLog() {
  const items = readJson(logFile(), []);
  eventLog = Array.isArray(items) ? items.slice(0, MAX_EVENT_LOG_ITEMS) : [];
}

function saveEventLog() {
  writeJson(logFile(), eventLog.slice(0, MAX_EVENT_LOG_ITEMS));
}

function sendLog() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log:updated', eventLog);
  }
}

function addLog(level, message, details = {}) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    level,
    message,
    details,
  };
  eventLog = [item, ...eventLog].slice(0, MAX_EVENT_LOG_ITEMS);
  saveEventLog();
  sendLog();
}

function sendStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notifications:status', payload);
  }
}

function sendUpdaterStatus(status, message = '', extra = {}) {
  const payload = { status, message, ...extra };
  if (status !== 'disabled' && status !== 'up-to-date') {
    addLog(status === 'error' ? 'error' : 'info', message || `Aggiornamento: ${status}`, extra);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', payload);
  }
  console.log(`[updater] ${status}${message ? `: ${message}` : ''}`);
}

function isConfigured(config) {
  return Boolean(config.nocHost && config.nocPort && config.username && config.password && config.technicianName);
}

function buildEndpoint(config) {
  const host = config.nocHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const url = new URL(`http://${host}:${config.nocPort}/api/technician-notifications`);
  url.searchParams.set('technician', config.technicianName);
  return url.toString();
}

function buildDashboardEndpoint(config) {
  const host = config.nocHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `http://${host}:${config.nocPort}/api/dashboard`;
}

function normalizeName(value = '') {
  return String(value || '').trim().toLowerCase();
}

function firstString(...values) {
  const match = values.find((value) => typeof value === 'string' && value.trim());
  return match ? match.trim() : '';
}

function isTicketAssignedToTechnician(ticket = {}, technicianName = '') {
  if (ticket.isAssignedToTechnician || ticket.isAssignedToMe || ticket.isMine) return true;

  const expectedName = normalizeName(technicianName);
  if (!expectedName) return false;

  const assignedName = normalizeName(firstString(
    ticket.assigneeName,
    ticket.assignedTo,
    ticket.assignedToName,
    ticket.ownerName,
    ticket.technicianName,
    ticket.agentName,
    ticket.assignedTo?.name,
    ticket.assignedTo?.fullName,
    ticket.assignee?.name,
    ticket.assignee?.fullName,
    ticket.owner?.name,
    ticket.owner?.fullName,
    ticket.agent?.name,
    ticket.agent?.fullName,
  ));

  return assignedName === expectedName;
}

function ticketSnapshot(ticket = {}, config = loadConfig()) {
  return {
    id: String(ticket.id || ticket.ticketNumber || ''),
    ticketNumber: String(ticket.ticketNumber || ''),
    subject: ticket.subject || 'Ticket Desk',
    customerName: ticket.accountName || ticket.customerName || '',
    status: ticket.status || 'Sconosciuto',
    urgencyLabel: ticket.urgencyLabel || '',
    isCriticalByRule: Boolean(ticket.isCriticalByRule),
    statusAgeLabel: ticket.statusAgeLabel || ticket.createdAgeLabel || '',
    webUrl: ticket.webUrl || '',
    assignedToMe: isTicketAssignedToTechnician(ticket, config.technicianName),
  };
}

function ticketKey(ticket = {}) {
  return String(ticket.id || ticket.ticketNumber || '');
}

function mergeTickets(...ticketLists) {
  const merged = new Map();
  for (const tickets of ticketLists) {
    for (const ticket of tickets || []) {
      const key = ticketKey(ticket);
      if (!key) continue;
      merged.set(key, {
        ...(merged.get(key) || {}),
        ...ticket,
      });
    }
  }
  return [...merged.values()];
}

function assignedTickets(tickets = [], config = loadConfig()) {
  return tickets.filter((ticket) => isTicketAssignedToTechnician(ticket, config.technicianName));
}

function normalizeStatus(status = '') {
  return String(status || '').trim().toLowerCase();
}

function isTechnicianActionStatus(status = '') {
  const normalized = normalizeStatus(status);
  return normalized === 'risposto' || normalized === 'da pianificare';
}

function buildEffectiveSummary(baseSummary = {}, dashboardPayload = null, notificationTickets = [], config = loadConfig()) {
  const dashboardTickets = Array.isArray(dashboardPayload?.tickets) ? dashboardPayload.tickets : [];
  const assignedSource = dashboardTickets.length > 0 ? dashboardTickets : notificationTickets;
  const technicianTickets = assignedTickets(assignedSource, config);

  return {
    ...baseSummary,
    assigned: technicianTickets.length,
    critical: technicianTickets.filter((ticket) => ticket.isCriticalByRule).length,
  };
}

function notificationBody(snapshot) {
  return [
    snapshot.customerName,
    snapshot.status,
    snapshot.statusAgeLabel ? `in stato da ${snapshot.statusAgeLabel}` : '',
  ].filter(Boolean).join(' | ');
}

function showAppNotification(title, body, onClick = () => showMainWindow()) {
  let shown = false;
  if (Notification.isSupported()) {
    let closedByUserDismissal = false;
    let clickTimer = null;
    const notification = new Notification({
      title,
      body,
      silent: false,
      urgency: 'critical',
      timeoutType: 'never',
    });
    notification.on('close', (event = {}, reason = '') => {
      const closeReason = reason || event.reason || '';
      if (closeReason === 'userCanceled' || closeReason === 'closeButtonClicked') {
        closedByUserDismissal = true;
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
      }
    });
    if (typeof onClick === 'function') {
      notification.on('click', () => {
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (!closedByUserDismissal) onClick();
        }, 300);
      });
    }
    notification.show();
    shown = true;
  }

  if (!shown && tray && process.platform === 'win32' && typeof tray.displayBalloon === 'function') {
    tray.displayBalloon({ title, content: body });
  }
}

function showTicketNotification(title, snapshot) {
  addLog(snapshot.isCriticalByRule ? 'warning' : 'info', title, snapshot);
  showAppNotification(title, notificationBody(snapshot), () => {
    if (!snapshot.webUrl) {
      addLog('warning', 'Link ticket non disponibile', {
        ticketNumber: snapshot.ticketNumber || snapshot.id,
      });
      return;
    }

    shell.openExternal(snapshot.webUrl).catch((error) => {
      addLog('error', 'Errore apertura link ticket', {
        message: error.message || String(error),
        webUrl: snapshot.webUrl,
      });
    });
  });
}

function processTickets(tickets = [], config = loadConfig()) {
  const nextSnapshot = new Map();
  const hasBaseline = lastSnapshot.size > 0;
  let emitted = 0;

  for (const ticket of tickets) {
    const snapshot = ticketSnapshot(ticket, config);
    if (!snapshot.id) continue;
    if (!snapshot.assignedToMe) continue;

    const previous = lastSnapshot.get(snapshot.id);
    if (
      isTechnicianActionStatus(snapshot.status) &&
      ((previous && previous.status !== snapshot.status) || (!previous && hasBaseline))
    ) {
      showTicketNotification(`Ticket #${snapshot.ticketNumber || snapshot.id} ${snapshot.status}`, snapshot);
      emitted += 1;
    } else if (!previous && hasBaseline) {
      showTicketNotification(`Nuovo ticket #${snapshot.ticketNumber || snapshot.id}`, snapshot);
      emitted += 1;
    } else if (previous && !previous.isCriticalByRule && snapshot.isCriticalByRule) {
      showTicketNotification(`Ticket #${snapshot.ticketNumber || snapshot.id} critico`, snapshot);
      emitted += 1;
    }

    nextSnapshot.set(snapshot.id, snapshot);
  }

  lastSnapshot = nextSnapshot;
  saveSnapshot(nextSnapshot);
  return emitted;
}

function shouldNotifyConnectionError() {
  const now = Date.now();
  if (lastConnectionState !== 'error') return true;
  return now - lastConnectionErrorNotificationAt >= CONNECTION_ERROR_REPEAT_MS;
}

function notifyConnectionError(message) {
  if (!shouldNotifyConnectionError()) return;
  lastConnectionErrorNotificationAt = Date.now();
  addLog('error', 'Errore connessione NOC', { message });
  showAppNotification('Tech Notify non comunica con il NOC', message);
}

function markConnectionOk() {
  if (lastConnectionState === 'error') {
    addLog('info', 'Connessione NOC ripristinata');
    showAppNotification('Tech Notify ricollegato', 'Connessione con il PC NOC ripristinata.');
  }
  lastConnectionState = 'ok';
}

function markConnectionError(message) {
  notifyConnectionError(message);
  lastConnectionState = 'error';
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = NOC_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text || `Risposta non valida dal NOC (${response.status})` };
    }
    return { response, payload };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`PC NOC non raggiungibile entro ${Math.round(timeoutMs / 1000)} secondi.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function checkNotifications() {
  const config = loadConfig();
  if (!isConfigured(config)) {
    addLog('warning', 'Configurazione incompleta');
    sendStatus({ status: 'missing-config', message: 'Completa la configurazione per avviare le notifiche.' });
    showMainWindow();
    return null;
  }

  const endpoint = buildEndpoint(config);
  try {
    const { response, payload } = await fetchJsonWithTimeout(endpoint, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(payload.message || `Errore HTTP ${response.status}`);
    let dashboardPayload = null;
    try {
      const dashboardResult = await fetchJsonWithTimeout(buildDashboardEndpoint(config), {
        cache: 'no-store',
      });
      if (dashboardResult.response.ok) {
        dashboardPayload = dashboardResult.payload;
      }
    } catch (error) {
      addLog('warning', 'Dashboard NOC non disponibile per il conteggio ticket assegnati', {
        message: error.message || String(error),
      });
    }

    const notificationTickets = assignedTickets(payload.tickets || [], config);
    const dashboardTickets = Array.isArray(dashboardPayload?.tickets) ? dashboardPayload.tickets : [];
    const dashboardAssignedTickets = assignedTickets(dashboardTickets, config);
    const ticketsToProcess = mergeTickets(notificationTickets, dashboardAssignedTickets);
    const summary = buildEffectiveSummary(payload.summary || {}, dashboardPayload, ticketsToProcess, config);
    const emitted = processTickets(ticketsToProcess, config);
    markConnectionOk();
    addLog('info', emitted > 0 ? `${emitted} notifiche inviate` : 'Controllo completato senza nuove notifiche', {
      assigned: summary.assigned || 0,
      unassignedNew: summary.unassignedNew || 0,
      critical: summary.critical || 0,
      stale: Boolean(payload.stale),
    });
    sendStatus({
      status: 'ok',
      message: emitted > 0 ? `${emitted} notifiche inviate.` : 'Nessuna nuova notifica.',
      checkedAt: new Date().toISOString(),
      summary,
      stale: payload.stale,
      staleReason: payload.staleReason,
    });
    return {
      ...payload,
      tickets: ticketsToProcess,
      summary,
    };
  } catch (error) {
    const message = error.message || String(error);
    markConnectionError(message);
    sendStatus({
      status: 'error',
      message,
      checkedAt: new Date().toISOString(),
    });
    return null;
  }
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const config = loadConfig();
  const intervalMs = Math.max(30, config.pollIntervalSeconds) * 1000;
  pollTimer = setInterval(() => {
    checkNotifications().catch(() => {});
  }, intervalMs);
}

function clearAutoUpdaterPolling() {
  if (updaterInitialCheckTimer) clearTimeout(updaterInitialCheckTimer);
  if (updaterIntervalTimer) clearTimeout(updaterIntervalTimer);
  updaterInitialCheckTimer = null;
  updaterIntervalTimer = null;
}

async function runAutoUpdaterCheck(reason = 'scheduled') {
  if (!app.isPackaged || updaterCheckInFlight) return;

  updaterCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    const label = reason === 'initial' ? 'Errore controllo aggiornamenti' : 'Errore controllo periodico';
    sendUpdaterStatus('error', `${label}: ${error.message || error}`);
  } finally {
    updaterCheckInFlight = false;
  }
}

async function installAvailableUpdate() {
  if (!app.isPackaged) {
    throw new Error('Aggiornamento disponibile solo nella app installata.');
  }
  if (!updateAvailable) {
    throw new Error('Nessun aggiornamento disponibile al momento.');
  }
  if (updaterInstallInProgress) {
    return;
  }

  updaterInstallInProgress = true;
  sendUpdaterStatus('downloading', 'Download aggiornamento in corso...', { percent: 0 });
  await autoUpdater.downloadUpdate();
}

function scheduleAutoUpdaterPolling() {
  clearAutoUpdaterPolling();
  updaterInitialCheckTimer = setTimeout(() => {
    runAutoUpdaterCheck('initial');
  }, UPDATER_INITIAL_DELAY_MS);

  const scheduleNextPeriodicCheck = () => {
    updaterIntervalTimer = setTimeout(async () => {
      await runAutoUpdaterCheck('periodic');
      scheduleNextPeriodicCheck();
    }, UPDATER_POLL_INTERVAL_MS);
  };

  scheduleNextPeriodicCheck();
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    sendUpdaterStatus('disabled', 'Auto-update attivo solo nelle build installate.');
    return;
  }

  if (updaterConfigured) {
    scheduleAutoUpdaterPolling();
    return;
  }

  updaterConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = false;

  autoUpdater.on('checking-for-update', () => sendUpdaterStatus('checking', 'Controllo aggiornamenti in corso...'));
  autoUpdater.on('update-available', (info) => {
    updateAvailable = true;
    const message = `Aggiornamento ${info.version} disponibile. Scaricalo manualmente da GitHub.`;
    sendUpdaterStatus('available', message, {
      version: info.version,
    });
    showAppNotification('Aggiornamento Tech Notify disponibile', message);
  });
  autoUpdater.on('update-not-available', () => {
    updateAvailable = false;
    sendUpdaterStatus('up-to-date', 'Nessun aggiornamento disponibile.');
  });
  autoUpdater.on('download-progress', (progressObj) => {
    sendUpdaterStatus('downloading', `Download aggiornamento: ${Math.round(progressObj.percent || 0)}%`, {
      percent: Math.round(progressObj.percent || 0),
      transferred: progressObj.transferred,
      total: progressObj.total,
      bytesPerSecond: progressObj.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdaterStatus('downloaded', `Aggiornamento ${info.version} pronto. Installazione in corso...`, {
      version: info.version,
      percent: 100,
    });
    clearAutoUpdaterPolling();
    setTimeout(() => {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }, 1200);
  });
  autoUpdater.on('error', (error) => sendUpdaterStatus('error', `Errore aggiornamento: ${error.message || error}`));

  scheduleAutoUpdaterPolling();
}

function createTray() {
  if (tray) return;
  const image = nativeImage.createFromDataURL('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="%23282f3a"/><circle cx="8" cy="8" r="4" fill="%2316a34a"/></svg>');
  tray = new Tray(image);
  tray.setToolTip('Tech Notify');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Apri configurazione', click: () => showMainWindow() },
    { label: 'Controlla ora', click: () => checkNotifications().catch(() => {}) },
    { type: 'separator' },
    {
      label: 'Esci',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 480,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f8fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

app.whenReady().then(() => {
  lastSnapshot = loadSnapshot();
  loadEventLog();
  createTray();
  createWindow();
  if (!isConfigured(loadConfig())) showMainWindow();
  checkNotifications().catch(() => {});
  schedulePolling();
  setupAutoUpdater();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (pollTimer) clearInterval(pollTimer);
  clearAutoUpdaterPolling();
});

app.on('window-all-closed', () => {});

ipcMain.handle('config:get', async () => ({
  ...loadConfig(),
  configPath: configFile(),
  log: eventLog,
}));

ipcMain.handle('config:save', async (event, payload) => {
  const config = saveConfig(payload);
  schedulePolling();
  checkNotifications().catch(() => {});
  return config;
});

ipcMain.handle('notifications:check-now', async () => checkNotifications());
ipcMain.handle('window:show', async () => showMainWindow());
ipcMain.handle('updater:install', async () => installAvailableUpdate());
ipcMain.handle('log:get', async () => eventLog);
