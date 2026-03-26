// Minimal service worker for PWA installability + notification support.
// No offline caching — autonomOS requires a live server connection.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Handle notification clicks — focus the app window
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          return client.focus();
        }
      }
      // Otherwise open a new one
      return self.clients.openWindow("/");
    })
  );
});
