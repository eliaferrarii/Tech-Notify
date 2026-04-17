const notificationShell = document.querySelector('.notification-shell');
const notificationContent = document.querySelector('#notificationContent');
const notificationTitle = document.querySelector('#notificationTitle');
const notificationBody = document.querySelector('#notificationBody');
const closeButton = document.querySelector('#closeButton');

let notificationId = '';
let actionCloses = true;
let currentAudio = null;

function playNotificationSound(soundUrl = '') {
  if (!soundUrl) return;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  currentAudio = new Audio(soundUrl);
  currentAudio.play().catch(() => {});
}

window.persistentNotification.onData((payload = {}) => {
  notificationId = payload.id || '';
  actionCloses = payload.actionCloses !== false;
  notificationTitle.textContent = payload.title || 'Notifica';
  notificationBody.textContent = payload.body || '';
  closeButton.textContent = payload.actionLabel || 'Chiudi';
  notificationShell.classList.toggle('notification-shell--critical', payload.variant === 'critical');
  playNotificationSound(payload.soundUrl || '');
});

notificationContent.addEventListener('click', () => {
  if (notificationId) {
    window.persistentNotification.activate(notificationId);
  }
});

closeButton.addEventListener('click', () => {
  if (notificationId) {
    if (actionCloses) {
      window.persistentNotification.close(notificationId);
      return;
    }
    window.persistentNotification.action(notificationId);
  }
});
