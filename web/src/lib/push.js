// Notifications for pings: this browser's own switch, off until whoever is signed in turns it on
// (docs/specs/IDEA-12-agent-pings.md). The service worker (/sw.js) shows them; the board stores the subscription as
// the owner's or the signed-in person's (BRK-340).
import { signal } from '@preact/signals';
import { api } from './api.js';
import { toast } from './store.js';
import { pushErrorMessage } from './push-errors.js';

/** off | on | blocked (permission denied) | nokey (the owner hasn't set a key up) | unsupported | busy */
export const notifications = signal('off');

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const bytes = (b64u) => {
  const b64 = b64u.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
};

async function registration() {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/** Registers the worker and reads this browser's state. Called once the owner or a person is signed in. */
export async function startNotifications() {
  if (!pushSupported()) {
    notifications.value = 'unsupported';
    return;
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    // The board is open and visible, so a ping is a toast rather than a second notification.
    if (e.data?.type === 'ping') toast(String(e.data.body ?? 'A ping needs you.').replace('\n', ': '), 'info');
  });
  try {
    await registration();
    const config = await api('push');
    if (!config.available) {
      notifications.value = 'nokey';
      return;
    }
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      await saveSubscription(sub); // keeps the board's copy current, and restores it if the board dropped it
      notifications.value = 'on';
    } else {
      notifications.value = Notification.permission === 'denied' ? 'blocked' : 'off';
    }
  } catch {
    notifications.value = 'off';
  }
}

const saveSubscription = (sub) => api('push/subscriptions', { method: 'POST', body: sub.toJSON() });

export async function turnOnNotifications() {
  if (!pushSupported()) return;
  notifications.value = 'busy';
  try {
    const config = await api('push');
    if (!config.available) {
      notifications.value = 'nokey';
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      notifications.value = permission === 'denied' ? 'blocked' : 'off';
      return;
    }
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(config.publicKey) }));
    await saveSubscription(sub);
    notifications.value = 'on';
    toast('Notifications are on in this browser.', 'success');
  } catch (error) {
    notifications.value = 'off';
    toast(pushErrorMessage(error), 'error');
  }
}

export async function turnOffNotifications() {
  notifications.value = 'busy';
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api('push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    notifications.value = 'off';
  } catch (error) {
    notifications.value = 'on';
    toast(error?.message ? String(error.message) : 'Couldn’t turn notifications off. Try again.', 'error');
  }
}
