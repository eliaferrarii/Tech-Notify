const configForm = document.querySelector('#configForm');
const configPath = document.querySelector('#configPath');
const checkNowButton = document.querySelector('#checkNowButton');
const statusPill = document.querySelector('#statusPill');
const statusMessage = document.querySelector('#statusMessage');
const checkedAt = document.querySelector('#checkedAt');
const appVersion = document.querySelector('#appVersion');
const assignedCount = document.querySelector('#assignedCount');
const unassignedNewCount = document.querySelector('#unassignedNewCount');
const criticalCount = document.querySelector('#criticalCount');
const calendarEventsCount = document.querySelector('#calendarEventsCount');
const updaterPanel = document.querySelector('#updaterPanel');
const updaterMessage = document.querySelector('#updaterMessage');
const updaterReleaseNotes = document.querySelector('#updaterReleaseNotes');
const updaterProgress = document.querySelector('#updaterProgress');
const updaterProgressFill = document.querySelector('#updaterProgressFill');
const updaterProgressValue = document.querySelector('#updaterProgressValue');
const updaterActions = document.querySelector('#updaterActions');
const checkUpdateButton = document.querySelector('#checkUpdateButton');
const installUpdateButton = document.querySelector('#installUpdateButton');
const eventsList = document.querySelector('#eventsList');
const notificationSoundPath = document.querySelector('#notificationSoundPath');
const importSoundButton = document.querySelector('#importSoundButton');
const removeSoundButton = document.querySelector('#removeSoundButton');
const testSoundButton = document.querySelector('#testSoundButton');

const bridge = window.techNotify;

function fillForm(config = {}) {
  configForm.elements.deskEnabled.checked = config.deskEnabled !== false;
  configForm.elements.nocHost.value = config.nocHost || '';
  configForm.elements.nocPort.value = config.nocPort || 8080;
  configForm.elements.username.value = config.username || '';
  configForm.elements.password.value = config.password || '';
  configForm.elements.technicianName.value = config.technicianName || '';
  configForm.elements.pollIntervalSeconds.value = config.pollIntervalSeconds || 60;
  configForm.elements.calendarEnabled.checked = Boolean(config.calendarEnabled);
  configForm.elements.calendarHost.value = config.calendarHost || '127.0.0.1';
  configForm.elements.calendarPort.value = config.calendarPort || 8090;
  configForm.elements.calendarUsername.value = config.calendarUsername || '';
  configForm.elements.calendarPassword.value = config.calendarPassword || '';
  configForm.elements.notificationSoundPath.value = config.notificationSoundPath || '';
  notificationSoundPath.value = config.notificationSoundPath || '';
  appVersion.textContent = config.appVersion ? `Versione ${config.appVersion}` : 'Versione -';
  configPath.textContent = config.configPath ? `Configurazione: ${config.configPath}` : '';
  syncSourceRequirements();
}

function formPayload() {
  return {
    deskEnabled: configForm.elements.deskEnabled.checked,
    nocHost: configForm.elements.nocHost.value,
    nocPort: configForm.elements.nocPort.value,
    username: configForm.elements.username.value,
    password: configForm.elements.password.value,
    technicianName: configForm.elements.technicianName.value,
    pollIntervalSeconds: configForm.elements.pollIntervalSeconds.value,
    calendarEnabled: configForm.elements.calendarEnabled.checked,
    calendarHost: configForm.elements.calendarHost.value,
    calendarPort: configForm.elements.calendarPort.value,
    calendarUsername: configForm.elements.calendarUsername.value,
    calendarPassword: configForm.elements.calendarPassword.value,
    notificationSoundPath: configForm.elements.notificationSoundPath.value,
  };
}

function setRequired(names, required) {
  for (const name of names) {
    configForm.elements[name].required = required;
  }
}

function syncSourceRequirements() {
  setRequired(['nocHost', 'nocPort', 'username', 'password'], configForm.elements.deskEnabled.checked);
  setRequired(
    ['calendarHost', 'calendarPort', 'calendarUsername', 'calendarPassword'],
    configForm.elements.calendarEnabled.checked
  );
}

function setStatusTone(status) {
  statusPill.classList.remove('ok', 'error', 'warning');
  if (status === 'ok') {
    statusPill.classList.add('ok');
    statusPill.textContent = 'Collegato';
    return;
  }
  if (status === 'error') {
    statusPill.classList.add('error');
    statusPill.textContent = 'Errore';
    return;
  }
  statusPill.classList.add('warning');
  statusPill.textContent = 'Da configurare';
}

function renderStatus(payload = {}) {
  setStatusTone(payload.status);
  statusMessage.textContent = payload.message || '';
  checkedAt.textContent = payload.checkedAt
    ? `Ultimo controllo: ${new Date(payload.checkedAt).toLocaleString('it-IT')}`
    : '';

  const summary = payload.summary || {};
  assignedCount.textContent = String(summary.assigned || 0);
  unassignedNewCount.textContent = String(summary.unassignedNew || 0);
  criticalCount.textContent = String(summary.critical || 0);
  calendarEventsCount.textContent = String(summary.calendarEvents || 0);

  if (payload.stale && payload.staleReason) {
    statusMessage.textContent = `${statusMessage.textContent} Cache server: ${payload.staleReason}`;
  }
  if (summary.deskError) {
    statusMessage.textContent = `${statusMessage.textContent} Desk non raggiungibile.`;
  }
  if (summary.calendarError) {
    statusMessage.textContent = `${statusMessage.textContent} Calendario non raggiungibile.`;
  }
}

function renderUpdaterStatus(payload = {}) {
  const status = String(payload.status || '');
  if (!status) {
    updaterMessage.textContent = 'Controllo aggiornamenti disponibile.';
    updaterReleaseNotes.classList.add('hidden');
    updaterReleaseNotes.textContent = '';
    updaterActions.classList.add('hidden');
    return;
  }

  updaterPanel.classList.remove('hidden');
  updaterPanel.classList.toggle('error', status === 'error');
  updaterMessage.textContent = payload.message || 'Aggiornamento in corso.';
  updaterReleaseNotes.textContent = payload.releaseNotes
    ? `Modifiche che verranno apportate:\n${payload.releaseNotes}`
    : '';
  updaterReleaseNotes.classList.toggle('hidden', !payload.releaseNotes);

  const showProgress = status === 'available' || status === 'downloading' || status === 'downloaded';
  updaterProgress.classList.toggle('hidden', !showProgress);
  const percent = status === 'downloaded' ? 100 : Math.max(0, Math.min(100, Math.round(payload.percent || 0)));
  updaterProgressFill.style.width = `${percent}%`;
  updaterProgressValue.textContent = `${percent}%`;
  updaterActions.classList.toggle('hidden', status !== 'available');
  checkUpdateButton.disabled = status === 'checking' || status === 'downloading' || status === 'downloaded';
  installUpdateButton.disabled = status !== 'available';
}

function logLevelLabel(level) {
  if (level === 'error') return 'Errore';
  if (level === 'warning') return 'Avviso';
  return 'Info';
}

function renderLog(items = []) {
  eventsList.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-log';
    empty.textContent = 'Nessun evento registrato.';
    eventsList.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, 40)) {
    const row = document.createElement('article');
    row.className = `event-row event-${item.level || 'info'}`;

    const badge = document.createElement('span');
    badge.className = 'event-badge';
    badge.textContent = logLevelLabel(item.level);

    const content = document.createElement('div');
    content.className = 'event-content';

    const message = document.createElement('strong');
    message.textContent = item.message || 'Evento';

    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = item.time ? new Date(item.time).toLocaleString('it-IT') : '';

    content.append(message, time);
    row.append(badge, content);
    eventsList.appendChild(row);
  }
}

async function loadConfig() {
  const config = await bridge.getConfig();
  fillForm(config);
  renderLog(config.log || await bridge.getLog());
}

async function saveConfig(event) {
  event.preventDefault();
  const saved = await bridge.saveConfig(formPayload());
  fillForm(saved);
  renderStatus({ status: 'ok', message: 'Configurazione salvata. Controllo notifiche avviato.' });
}

async function checkNow() {
  checkNowButton.disabled = true;
  try {
    const payload = await bridge.checkNow();
    if (!payload) return;
    renderStatus({
      status: 'ok',
      message: 'Controllo completato.',
      checkedAt: new Date().toISOString(),
      summary: payload.summary || {},
      stale: payload.stale,
      staleReason: payload.staleReason,
    });
  } finally {
    checkNowButton.disabled = false;
  }
}

async function installUpdate() {
  installUpdateButton.disabled = true;
  try {
    await bridge.installUpdate();
  } catch (error) {
    renderUpdaterStatus({
      status: 'error',
      message: error.message || 'Errore avvio aggiornamento.',
    });
  }
}

async function checkUpdateNow() {
  checkUpdateButton.disabled = true;
  try {
    await bridge.checkUpdateNow();
  } catch (error) {
    renderUpdaterStatus({
      status: 'error',
      message: error.message || 'Errore controllo aggiornamenti.',
    });
  } finally {
    checkUpdateButton.disabled = false;
  }
}

async function importNotificationSound() {
  importSoundButton.disabled = true;
  try {
    const saved = await bridge.importNotificationSound();
    fillForm(saved);
    if (saved.imported) {
      renderStatus({ status: 'ok', message: 'Suono notifica importato.' });
    }
  } catch (error) {
    renderStatus({ status: 'error', message: error.message || 'Errore importazione suono.' });
  } finally {
    importSoundButton.disabled = false;
  }
}

async function removeNotificationSound() {
  configForm.elements.notificationSoundPath.value = '';
  notificationSoundPath.value = '';
  const saved = await bridge.saveConfig(formPayload());
  fillForm(saved);
  renderStatus({ status: 'ok', message: 'Suono notifica rimosso.' });
}

async function testNotificationSound() {
  if (!configForm.elements.notificationSoundPath.value) {
    renderStatus({ status: 'error', message: 'Importa un file MP3 prima di provare il suono.' });
    return;
  }

  testSoundButton.disabled = true;
  try {
    await bridge.testNotificationSound();
  } finally {
    testSoundButton.disabled = false;
  }
}

configForm.addEventListener('submit', saveConfig);
configForm.elements.deskEnabled.addEventListener('change', syncSourceRequirements);
configForm.elements.calendarEnabled.addEventListener('change', syncSourceRequirements);
checkNowButton.addEventListener('click', checkNow);
checkUpdateButton.addEventListener('click', checkUpdateNow);
installUpdateButton.addEventListener('click', installUpdate);
importSoundButton.addEventListener('click', importNotificationSound);
removeSoundButton.addEventListener('click', removeNotificationSound);
testSoundButton.addEventListener('click', testNotificationSound);
bridge.onStatus(renderStatus);
bridge.onUpdaterStatus(renderUpdaterStatus);
bridge.onLogUpdated(renderLog);
loadConfig().catch((error) => {
  renderStatus({ status: 'error', message: error.message || 'Errore lettura configurazione.' });
});
