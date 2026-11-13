// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import { notificationPermission } from "./notifications.js";

/**
 * Web Push (12 §5.4): the browser subscribes to the push service and the server sends there, so messages arrive
 * with every tab closed. The page only keeps the subscription registered; showing it is the service worker's job.
 */

const OPT_OUT = "tincan.push.off";

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined"
  );
}

export function pushOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT) === "1";
  } catch {
    return false;
  }
}

function setOptedOut(off: boolean): void {
  try {
    if (off) localStorage.setItem(OPT_OUT, "1");
    else localStorage.removeItem(OPT_OUT);
  } catch {
    // Private mode: the choice just lasts until the page closes.
  }
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Subscribes (or refreshes the registration) when permission is granted and the user has not turned push off. */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || notificationPermission() !== "granted" || pushOptedOut()) return;
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // The instance secret changed: the old subscription belongs to a key the server no longer has.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
  await api.putPush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
}

/** Removes this browser's subscription from the server and the push service. */
export async function unsubscribePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api.deletePush(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

export async function setPushEnabled(on: boolean): Promise<void> {
  setOptedOut(!on);
  if (on) await syncPush();
  else await unsubscribePush();
}

/** Keeps the subscription registered while signed in and notifications are allowed. */
export function usePushSync(enabled: boolean, permission: string): void {
  useEffect(() => {
    if (!enabled || permission !== "granted") return;
    void syncPush().catch(() => undefined);
  }, [enabled, permission]);
}

/** Whether this browser is currently subscribed, for the settings toggle. */
export function usePushState(): { supported: boolean; on: boolean; busy: boolean; toggle: () => void } {
  const [on, setOn] = useState(!pushOptedOut());
  const [busy, setBusy] = useState(false);
  return {
    supported: pushSupported(),
    on,
    busy,
    toggle: () => {
      setBusy(true);
      const next = !on;
      void setPushEnabled(next)
        .then(() => setOn(next))
        .catch(() => undefined)
        .finally(() => setBusy(false));
    },
  };
}
