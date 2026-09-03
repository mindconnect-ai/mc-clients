// FCM wiring, kept optional: without a firebase-config the app works,
// the phone just doesn't ring. getPushToken() resolves to the FCM token
// (asking for notification permission on first use) or rejects — callers
// treat that as "no push, carry on".
import { firebaseConfig, vapidKey } from './firebase-config.js';

let tokenPromise = null;

export function initPush() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

export function getPushToken() {
  if (!firebaseConfig || !vapidKey) return Promise.reject(new Error('push not configured'));
  tokenPromise ??= (async () => {
    const { initializeApp, getApps, getApp } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const { getMessaging, getToken } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js');
    if (await Notification.requestPermission() !== 'granted') {
      throw new Error('notifications denied');
    }
    const registration = await navigator.serviceWorker.ready;
    // The RTDB transport may have initialized the app already.
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    return getToken(getMessaging(app),
        { vapidKey, serviceWorkerRegistration: registration });
  })();
  return tokenPromise;
}
