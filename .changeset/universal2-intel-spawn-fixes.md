---
"@autonomos/app": patch
---

Fixed: the universal2 macOS app now runs on Intel Macs (a native HTTP dependency failed to load) and Built-in mode reliably spawns agents on both Apple Silicon and Intel (the bundled PTY spawn helper wasn't shipped correctly). Earlier 0.0.x desktop builds were affected.
