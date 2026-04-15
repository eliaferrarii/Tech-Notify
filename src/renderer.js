const configForm = document.querySelector('#configForm');
const configPath = document.querySelector('#configPath');
const checkNowButton = document.querySelector('#checkNowButton');
const statusPill = document.querySelector('#statusPill');
const statusMessage = document.querySelector('#statusMessage');
const checkedAt = document.querySelector('#checkedAt');
const assignedCount = document.querySelector('#assignedCount');
const unassignedNewCount = document.querySelector('#unassignedNewCount');
const criticalCount = document.querySelector('#criticalCount');
const updaterPanel = document.querySelector('#updaterPanel');
const updaterMessage = document.querySelector('#updaterMessage');
const updaterProgress = document.querySelector('#updaterProgress');
const updaterProgressFill = document.querySelector('#updaterProgressFill');
const updaterProgressValue = document.querySelector('#updaterProgressValue');

const bridge = window.techNotify;

function fillForm(config = {}) {
  configForm.elements.nocHost.value = config.nocHost || '';
  configForm.elements.nocPort.value = config.nocPort || 8080;
  configForm.elements.username.value = config.username || '';
  configForm.elements.password.value = config.password || '';
  configForm.elements.technicianName.value = config.technicianName || '';
  configForm.elements.pollIntervalSeconds.value = config.pollIntervalSeconds || 60;
  configPath.textContent = config.configPath ? `Configurazione: ${config.configPath}` : '';
}

function formPayload() {
  return {
    nocHost: configForm.elements.nocHost.value,
    nocPort: configForm.elements.nocPort.value,
    username: configForm.elements.username.value,
    password: configForm.elements.password.value,
    technicianName: configForm.elements.technicianName.value,
    pollIntervalSeconds: configForm.elements.pollIntervalSeconds.value,
  };
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

  if (payload.stale && payload.staleReason) {
    statusMessage.textContent = `${statusMessage.textContent} Cache NOC: ${payload.staleReason}`;
  }
}

function renderUpdaterStatus(payload = {}) {
  const status = String(payload.status || '');
  if (!status || status === 'disabled' || status === 'up-to-date') {
    updaterPanel.classList.add('hidden');
    return;
  }

  updaterPanel.classList.remove('hidden');
  updaterPanel.classList.toggle('error', status === 'error');
  updaterMessage.textContent = payload.message || 'Aggiornamento in corso.';

  const showProgress = status === 'available' || status === 'downloading' || status === 'downloaded';
  updaterProgress.classList.toggle('hidden', !showProgress);
  const percent = status === 'downloaded' ? 100 : Math.max(0, Math.min(100, Math.round(payload.percent || 0)));
  updaterProgressFill.style.width = `${percent}%`;
  updaterProgressValue.textContent = `${percent}%`;
}

async function loadConfig() {
  fillForm(await bridge.getConfig());
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

configForm.addEventListener('submit', saveConfig);
checkNowButton.addEventListener('click', checkNow);
bridge.onStatus(renderStatus);
bridge.onUpdaterStatus(renderUpdaterStatus);
loadConfig().catch((error) => {
  renderStatus({ status: 'error', message: error.message || 'Errore lettura configurazione.' });
});
