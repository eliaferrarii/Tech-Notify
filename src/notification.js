const notificationShell = document.querySelector('.notification-shell');
const notificationContent = document.querySelector('#notificationContent');
const notificationTitle = document.querySelector('#notificationTitle');
const notificationBody = document.querySelector('#notificationBody');
const closeButton = document.querySelector('#closeButton');
const notificationBubble = document.querySelector('#notificationBubble');
const notificationBubbleCount = document.querySelector('#notificationBubbleCount');

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
  if (payload.mode === 'bubble') {
    const count = Number(payload.count || 0);
    if (count < 1) {
      notificationShell.classList.remove('notification-shell--bubble');
      return;
    }

    notificationId = '';
    notificationBubbleCount.textContent = String(count);
    notificationShell.classList.add('notification-shell--bubble');
    notificationShell.classList.remove('notification-shell--critical');
    return;
  }

  notificationId = payload.id || '';
  actionCloses = payload.actionCloses !== false;
  notificationTitle.textContent = payload.title || 'Notifica';
  notificationBody.textContent = payload.body || '';
  closeButton.textContent = payload.actionLabel || 'Chiudi';
  notificationShell.classList.remove('notification-shell--bubble');
  notificationShell.classList.remove('notification-shell--update');
  notificationShell.classList.toggle('notification-shell--critical', payload.variant === 'critical');
  notificationShell.classList.toggle('notification-shell--update', payload.variant === 'update');
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

notificationBubble.addEventListener('click', () => {
  window.persistentNotification.expand();
});
