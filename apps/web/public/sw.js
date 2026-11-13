// SPDX-License-Identifier: AGPL-3.0-or-later
/* global self, caches */
/* Tin Can service worker. It exists so the app can be installed and opens its shell without a network.
 *
 * What it does and does not do:
 *  - hashed build files under /assets/ are cached as they are fetched (they never change under one name);
 *  - the page itself (navigations) goes to the network first, so an update shows at once, and falls back to the
 *    cached shell when the server cannot be reached;
 *  - everything else is left alone: the API, the WebSocket gateway, files, avatars and LiveKit are never cached,
 *    so private data is not kept on the device and nothing can be served stale.
 * It does not precache, so it needs no version bump when the app changes. */

const ASSETS = "tincan-assets-v1";
const SHELL = "tincan-shell-v1";
const KEEP = [ASSETS, SHELL];
const MAX_ASSETS = 300;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("tincan-") && !KEEP.includes(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** Only same-origin GETs for build files and the page are handled. */
function route(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return null;
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) return "asset";
  if (request.mode === "navigate") return "page";
  return null;
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const kind = route(request, new URL(request.url));
  if (kind === "asset") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSETS);
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) {
          await cache.put(request, res.clone());
          await trim(cache);
        }
        return res;
      })(),
    );
  } else if (kind === "page") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        try {
          const res = await fetch(request);
          // Any page of the single-page app is the same shell; keep one copy.
          if (res.ok && res.headers.get("content-type")?.includes("text/html")) {
            await cache.put("/", res.clone());
          }
          return res;
        } catch (err) {
          const shell = await cache.match("/");
          if (shell) return shell;
          throw err;
        }
      })(),
    );
  }
});

/* Notifications are shown from the page (registration.showNotification) so they work in background tabs and on
 * mobile. A click focuses an open window and tells it which channel to open, or opens the app if none is. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const msg = { type: "notification-click", channelId: data.channelId, messageId: data.messageId };
      const win = list.find((c) => "focus" in c) || null;
      if (win) {
        await win.focus();
        win.postMessage(msg);
      } else if (data.channelId) {
        await self.clients.openWindow("/channels/" + data.channelId);
      }
    })(),
  );
});

/* Web Push: the server sends {channelId, messageId, title, body} (encrypted) when a member's app is closed. The tag
 * is the channel, so a newer message replaces the one still showing, as the in-page notification does. A push that
 * arrives while a window is focused and visible is not shown: the page is already showing the message. */
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  if (!data || typeof data.title !== "string") return;
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (list.some((c) => c.focused && c.visibilityState === "visible")) return;
      await self.registration.showNotification(data.title, {
        body: typeof data.body === "string" ? data.body : "",
        tag: data.channelId,
        icon: "/icons/icon-192.png",
        data: { channelId: data.channelId, messageId: data.messageId },
      });
    })(),
  );
});

/* The browser rotated or dropped the subscription: tell an open page to register the new one. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) c.postMessage({ type: "push-resubscribe" });
    })(),
  );
});
