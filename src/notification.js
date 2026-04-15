const notificationContent = document.querySelector('#notificationContent');
const notificationTitle = document.querySelector('#notificationTitle');
const notificationBody = document.querySelector('#notificationBody');
const closeButton = document.querySelector('#closeButton');

let notificationId = '';

window.persistentNotification.onData((payload = {}) => {
  notificationId = payload.id || '';
  notificationTitle.textContent = payload.title || 'Notifica';
  notificationBody.textContent = payload.body || '';
});

notificationContent.addEventListener('click', () => {
  if (notificationId) {
    window.persistentNotification.activate(notificationId);
  }
});

closeButton.addEventListener('click', () => {
  if (notificationId) {
    window.persistentNotification.close(notificationId);
  }
});
