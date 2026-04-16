const { app, BrowserWindow, Notification, Menu, Tray, ipcMain, nativeImage, screen, shell } = require('electron');
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
let lastCalendarSnapshot = new Map();
let lastConnectionState = 'unknown';
let eventLog = [];
let notificationIdSequence = 0;
const persistentNotifications = new Map();
const persistentNotificationActions = new Map();

const APP_USER_MODEL_ID = 'com.mirkotagliente.technotify';
const UPDATER_INITIAL_DELAY_MS = 5000;
const UPDATER_POLL_INTERVAL_MS = 10 * 60 * 1000;
const NOC_REQUEST_TIMEOUT_MS = 12_000;
const MAX_EVENT_LOG_ITEMS = 80;
const PERSISTENT_NOTIFICATION_WIDTH = 380;
const PERSISTENT_NOTIFICATION_HEIGHT = 196;
const PERSISTENT_NOTIFICATION_MARGIN = 16;
const PERSISTENT_NOTIFICATION_GAP = 12;
const CALENDAR_REMINDER_LEAD_MS = 15 * 60 * 1000;
const CALENDAR_MISSED_REMINDER_GRACE_MS = 30 * 60 * 1000;
const DEFAULT_CONFIG = {
  nocHost: '',
  nocPort: 8080,
  username: '',
  password: '',
  technicianName: '',
  pollIntervalSeconds: 60,
  calendarEnabled: false,
  calendarHost: '127.0.0.1',
  calendarPort: 8090,
  calendarUsername: '',
  calendarPassword: '',
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

function calendarStateFile() {
  return path.join(app.getPath('userData'), 'calendar-notification-state.json');
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
    calendarEnabled: Boolean(payload.calendarEnabled),
    calendarHost: String(payload.calendarHost || DEFAULT_CONFIG.calendarHost).trim(),
    calendarPort: Number(payload.calendarPort || DEFAULT_CONFIG.calendarPort),
    calendarUsername: String(payload.calendarUsername || '').trim(),
    calendarPassword: String(payload.calendarPassword || ''),
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

function loadCalendarSnapshot() {
  const items = readJson(calendarStateFile(), []);
  if (!Array.isArray(items)) return new Map();
  return new Map(items.filter((item) => item?.id).map((item) => [String(item.id), item]));
}

function saveCalendarSnapshot(snapshot) {
  writeJson(calendarStateFile(), [...snapshot.values()]);
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

function isCalendarConfigured(config) {
  return Boolean(
    config.calendarEnabled &&
    config.calendarHost &&
    config.calendarPort &&
    config.calendarUsername &&
    config.calendarPassword &&
    config.technicianName
  );
}

function buildEndpoint(config) {
  const host = config.nocHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const url = new URL(`http://${host}:${config.nocPort}/api/technician-notifications`);
  url.searchParams.set('technician', config.technicianName);
  return url.toString();
}

function buildCalendarEndpoint(config) {
  const host = config.calendarHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const url = new URL(`http://${host}:${config.calendarPort}/api/technician-notifications`);
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
    priority: typeof ticket.priority === 'string' ? ticket.priority : '',
    isCriticalByRule: Boolean(ticket.isCriticalByRule),
    statusAgeLabel: ticket.statusAgeLabel || ticket.createdAgeLabel || '',
    assigneeName: ticket.assigneeName || ticket.assignedToName || ticket.assignedTo?.name || '',
    webUrl: ticket.webUrl || '',
    assignedToMe: isTicketAssignedToTechnician(ticket, config.technicianName),
    isUnassigned: Boolean(ticket.isUnassigned ?? !ticket.assigneeId),
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

function ticketNotificationTitle(type, snapshot = {}) {
  const status = String(snapshot.status || '').trim();
  if (type === 'new') return 'Nuovo ticket Deskz';
  if (type === 'critical') return 'Ticket Deskz critico';
  if (type === 'action' && status) return `Ticket Deskz ${status.toLowerCase()}`;
  return 'Ticket Deskz aggiornato';
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
    snapshot.ticketNumber ? `#${snapshot.ticketNumber}` : '',
    snapshot.subject,
    snapshot.customerName,
    snapshot.status ? `Stato: ${snapshot.status}` : '',
    snapshot.urgencyLabel ? `Urgenza: ${snapshot.urgencyLabel}` : '',
    snapshot.assigneeName ? `Assegnato a: ${snapshot.assigneeName}` : (snapshot.isUnassigned ? 'Non assegnato' : ''),
    snapshot.statusAgeLabel ? `in stato da ${snapshot.statusAgeLabel}` : '',
  ].filter(Boolean).join(' - ');
}

function escapeXml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function showWindowsProtocolNotification(title, body, url) {
  if (process.platform !== 'win32' || !Notification.isSupported() || !url) return false;

  const notification = new Notification({
    silent: false,
    toastXml: `
      <toast activationType="protocol" launch="${escapeXml(url)}">
        <visual>
          <binding template="ToastGeneric">
            <text>${escapeXml(title)}</text>
            <text>${escapeXml(body)}</text>
          </binding>
        </visual>
      </toast>
    `,
  });

  notification.on('failed', (event = {}, error = '') => {
    addLog('error', 'Errore notifica Windows', {
      message: error || event.error || 'Toast XML non valida',
    });
  });
  notification.show();
  return true;
}

function positionPersistentNotifications() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const windows = [...persistentNotifications.values()].filter((notificationWindow) => !notificationWindow.isDestroyed());

  windows.forEach((notificationWindow, index) => {
    const windowX = x + width - PERSISTENT_NOTIFICATION_WIDTH - PERSISTENT_NOTIFICATION_MARGIN;
    const windowY = y + height - PERSISTENT_NOTIFICATION_HEIGHT - PERSISTENT_NOTIFICATION_MARGIN
      - (index * (PERSISTENT_NOTIFICATION_HEIGHT + PERSISTENT_NOTIFICATION_GAP));
    notificationWindow.setBounds({
      x: Math.max(x + PERSISTENT_NOTIFICATION_MARGIN, windowX),
      y: Math.max(y + PERSISTENT_NOTIFICATION_MARGIN, windowY),
      width: PERSISTENT_NOTIFICATION_WIDTH,
      height: PERSISTENT_NOTIFICATION_HEIGHT,
    });
  });
}

function closePersistentNotification(id) {
  const notificationWindow = persistentNotifications.get(id);
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow.close();
  }
}

function showPersistentNotification(title, body, onActivate = null, options = {}) {
  if (!app.isReady()) return false;

  const id = String(++notificationIdSequence);
  const notificationWindow = new BrowserWindow({
    width: PERSISTENT_NOTIFICATION_WIDTH,
    height: PERSISTENT_NOTIFICATION_HEIGHT,
    minWidth: PERSISTENT_NOTIFICATION_WIDTH,
    minHeight: PERSISTENT_NOTIFICATION_HEIGHT,
    maxWidth: PERSISTENT_NOTIFICATION_WIDTH,
    maxHeight: PERSISTENT_NOTIFICATION_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'notification-preload.js'),
    },
  });

  persistentNotifications.set(id, notificationWindow);
  if (typeof onActivate === 'function') {
    persistentNotificationActions.set(id, onActivate);
  }

  notificationWindow.once('ready-to-show', () => {
    positionPersistentNotifications();
    notificationWindow.showInactive();
    notificationWindow.webContents.send('notification:data', {
      id,
      title,
      body,
      actionLabel: options.actionLabel || 'Chiudi',
      actionCloses: options.actionCloses !== false,
    });
  });

  notificationWindow.on('closed', () => {
    persistentNotifications.delete(id);
    persistentNotificationActions.delete(id);
    positionPersistentNotifications();
  });

  notificationWindow.loadFile(path.join(__dirname, 'notification.html')).catch((error) => {
    addLog('error', 'Errore apertura notifica persistente', {
      message: error.message || String(error),
    });
    persistentNotifications.delete(id);
    persistentNotificationActions.delete(id);
  });

  return true;
}

function showAppNotification(title, body, onClick = () => showMainWindow(), options = {}) {
  if (showPersistentNotification(title, body, onClick, options)) {
    return;
  }

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

function eventSnapshot(event = {}) {
  return {
    id: String(event.id || event.eventId || event.uid || event.calendarEventId || ''),
    title: event.title || event.subject || event.summary || 'Evento calendario',
    calendarName: event.calendarName || event.calendar || '',
    startLabel: event.startLabel || event.whenLabel || event.timeLabel || '',
    startTime: event.startTime || event.start || event.startsAt || event.startDateTime || '',
    endTime: event.endTime || event.end || event.endsAt || event.endDateTime || '',
    location: event.location || event.where || '',
    status: event.status || '',
    webUrl: event.webUrl || event.url || event.htmlLink || '',
  };
}

function hasCalendarEventChanged(previous = {}, snapshot = {}) {
  return [
    'title',
    'calendarName',
    'startLabel',
    'startTime',
    'endTime',
    'location',
    'status',
    'webUrl',
  ].some((field) => previous[field] !== snapshot[field]);
}

function formatCalendarDateTime(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const eventDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayLabel = eventDay === today
    ? 'Oggi'
    : date.toLocaleDateString('it-IT', {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
      });
  const timeLabel = date.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${dayLabel} ${timeLabel}`;
}

function formatCalendarWhen(snapshot = {}) {
  if (snapshot.startLabel) return snapshot.startLabel;

  const start = formatCalendarDateTime(snapshot.startTime);
  const end = formatCalendarDateTime(snapshot.endTime);
  if (!start) return '';
  if (!end) return start;

  const startDay = new Date(snapshot.startTime).toDateString();
  const endDate = new Date(snapshot.endTime);
  if (!Number.isNaN(endDate.getTime()) && startDay === endDate.toDateString()) {
    const endTime = endDate.toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${start}-${endTime}`;
  }

  return `${start} - ${end}`;
}

function shouldSendCalendarReminder(snapshot = {}, previous = null, now = Date.now()) {
  if (!snapshot.startTime || previous?.reminderSent) return false;
  const startTime = new Date(snapshot.startTime).getTime();
  if (Number.isNaN(startTime)) return false;
  const timeUntilStart = startTime - now;
  const timeSinceStart = now - startTime;
  return (
    (timeUntilStart >= 0 && timeUntilStart <= CALENDAR_REMINDER_LEAD_MS) ||
    (timeSinceStart >= 0 && timeSinceStart <= CALENDAR_MISSED_REMINDER_GRACE_MS)
  );
}

function calendarReminderTitle(snapshot = {}, now = Date.now()) {
  const startTime = new Date(snapshot.startTime).getTime();
  if (!Number.isNaN(startTime) && startTime < now) {
    return 'Promemoria calendario perso';
  }
  return 'Promemoria calendario';
}

function eventBody(snapshot) {
  return [
    snapshot.title,
    formatCalendarWhen(snapshot),
    snapshot.location,
    snapshot.calendarName,
  ].filter(Boolean).join(' - ');
}

function showCalendarNotification(title, snapshot) {
  addLog('info', title, snapshot);
  showAppNotification(title, eventBody(snapshot), () => {
    if (snapshot.webUrl) {
      shell.openExternal(snapshot.webUrl).catch((error) => {
        addLog('error', 'Errore apertura evento calendario', {
          message: error.message || String(error),
          webUrl: snapshot.webUrl,
        });
      });
      return;
    }

    showMainWindow();
  });
}

function processCalendarEvents(events = []) {
  const nextSnapshot = new Map();
  const hasBaseline = lastCalendarSnapshot.size > 0;
  let emitted = 0;

  for (const event of events) {
    const snapshot = eventSnapshot(event);
    if (!snapshot.id) continue;

    const previous = lastCalendarSnapshot.get(snapshot.id);
    if (!previous && hasBaseline) {
      showCalendarNotification('Nuovo evento calendario', snapshot);
      emitted += 1;
    } else if (previous && hasCalendarEventChanged(previous, snapshot)) {
      showCalendarNotification('Evento calendario aggiornato', snapshot);
      emitted += 1;
    }

    if (shouldSendCalendarReminder(snapshot, previous)) {
      showCalendarNotification(calendarReminderTitle(snapshot), snapshot);
      emitted += 1;
      snapshot.reminderSent = true;
    } else {
      snapshot.reminderSent = Boolean(previous?.reminderSent);
    }

    nextSnapshot.set(snapshot.id, snapshot);
  }

  lastCalendarSnapshot = nextSnapshot;
  saveCalendarSnapshot(nextSnapshot);
  return emitted;
}

function processTickets(tickets = [], config = loadConfig()) {
  const nextSnapshot = new Map();
  const hasBaseline = lastSnapshot.size > 0;
  let emitted = 0;

  for (const ticket of tickets) {
    const snapshot = ticketSnapshot(ticket, config);
    if (!snapshot.id) continue;
    if (!snapshot.assignedToMe && !snapshot.isUnassigned) continue;

    const previous = lastSnapshot.get(snapshot.id);
    if (
      snapshot.assignedToMe &&
      isTechnicianActionStatus(snapshot.status) &&
      ((previous && previous.status !== snapshot.status) || (!previous && hasBaseline))
    ) {
      showTicketNotification(ticketNotificationTitle('action', snapshot), snapshot);
      emitted += 1;
    } else if (!previous && hasBaseline) {
      showTicketNotification(ticketNotificationTitle('new', snapshot), snapshot);
      emitted += 1;
    } else if (previous && !previous.isCriticalByRule && snapshot.isCriticalByRule) {
      showTicketNotification(ticketNotificationTitle('critical', snapshot), snapshot);
      emitted += 1;
    }

    nextSnapshot.set(snapshot.id, snapshot);
  }

  lastSnapshot = nextSnapshot;
  saveSnapshot(nextSnapshot);
  return emitted;
}

function shouldNotifyConnectionError() {
  return lastConnectionState !== 'error';
}

function notifyConnectionError(message) {
  if (!shouldNotifyConnectionError()) return;
  addLog('error', 'Errore connessione server', { message });
  showAppNotification('Tech Notify non comunica con il server', message);
}

function markConnectionOk() {
  if (lastConnectionState === 'error') {
    addLog('info', 'Connessione server ripristinata');
    showAppNotification('Tech Notify ricollegato', 'Connessione con il server ripristinata.');
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
      payload = { message: text || `Risposta non valida dal server (${response.status})` };
    }
    return { response, payload };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Server non raggiungibile entro ${Math.round(timeoutMs / 1000)} secondi.`);
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
      addLog('warning', 'Dashboard server non disponibile per il conteggio ticket assegnati', {
        message: error.message || String(error),
      });
    }

    const notificationTickets = Array.isArray(payload.tickets) ? payload.tickets : [];
    const dashboardTickets = Array.isArray(dashboardPayload?.tickets) ? dashboardPayload.tickets : [];
    const dashboardAssignedTickets = assignedTickets(dashboardTickets, config);
    const ticketsToProcess = mergeTickets(notificationTickets, dashboardAssignedTickets);
    const summary = buildEffectiveSummary(payload.summary || {}, dashboardPayload, ticketsToProcess, config);
    let emitted = processTickets(ticketsToProcess, config);
    let calendarPayload = null;

    if (isCalendarConfigured(config)) {
      try {
        const calendarResult = await fetchJsonWithTimeout(buildCalendarEndpoint(config), {
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.calendarUsername}:${config.calendarPassword}`).toString('base64')}`,
            Accept: 'application/json',
          },
          cache: 'no-store',
        });
        if (!calendarResult.response.ok) {
          throw new Error(calendarResult.payload.message || `Errore HTTP ${calendarResult.response.status}`);
        }

        calendarPayload = calendarResult.payload;
        const calendarEvents = Array.isArray(calendarPayload.events) ? calendarPayload.events : [];
        emitted += processCalendarEvents(calendarEvents);
        summary.calendarEvents = calendarEvents.length;
        summary.calendarToday = calendarPayload.summary?.today || calendarPayload.summary?.todayEvents || 0;
        summary.calendarUpcoming = calendarPayload.summary?.upcoming || calendarPayload.summary?.upcomingEvents || 0;
      } catch (error) {
        addLog('warning', 'Calendarioz non disponibile', {
          message: error.message || String(error),
        });
        summary.calendarError = true;
      }
    } else {
      summary.calendarEvents = 0;
    }

    markConnectionOk();
    addLog('info', emitted > 0 ? `${emitted} notifiche inviate` : 'Controllo completato senza nuove notifiche', {
      assigned: summary.assigned || 0,
      unassignedNew: summary.unassignedNew || 0,
      critical: summary.critical || 0,
      calendarEvents: summary.calendarEvents || 0,
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
      calendar: calendarPayload,
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
  if (!app.isPackaged) {
    if (reason === 'manual') {
      sendUpdaterStatus('disabled', 'Controllo aggiornamenti disponibile solo nella app installata.');
    }
    return;
  }
  if (updaterCheckInFlight) {
    if (reason === 'manual') {
      sendUpdaterStatus('checking', 'Controllo aggiornamenti gia in corso...');
    }
    return;
  }

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
    const message = `Aggiornamento ${info.version} disponibile.`;
    sendUpdaterStatus('available', message, {
      version: info.version,
    });
    showAppNotification(
      'Aggiornamento Tech Notify disponibile',
      message,
      () => {
        installAvailableUpdate().catch((error) => {
          sendUpdaterStatus('error', `Errore aggiornamento: ${error.message || error}`);
        });
      },
      { actionLabel: 'Aggiorna' },
    );
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
  for (const notificationWindow of persistentNotifications.values()) {
    if (!notificationWindow.isDestroyed()) notificationWindow.close();
  }
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
ipcMain.handle('persistent-notification:activate', async (event, id) => {
  const action = persistentNotificationActions.get(String(id));
  if (typeof action === 'function') action();
});
ipcMain.handle('persistent-notification:action', async (event, id) => {
  const action = persistentNotificationActions.get(String(id));
  if (typeof action === 'function') action();
  closePersistentNotification(String(id));
});
ipcMain.handle('persistent-notification:close', async (event, id) => closePersistentNotification(String(id)));
ipcMain.handle('updater:check-now', async () => runAutoUpdaterCheck('manual'));
ipcMain.handle('updater:install', async () => installAvailableUpdate());
ipcMain.handle('log:get', async () => eventLog);
