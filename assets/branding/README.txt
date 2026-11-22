PROJECT NEXUS — Windows Icon Suite

Files:
- PROJECT-NEXUS.ico: multi-resolution Windows application icon (256, 128, 64, 48, 32, 16 px)
- PROJECT-NEXUS-icon-1024.png: transparent rounded-square master icon
- PROJECT-NEXUS-icon-512.png ... -16.png: PNG exports at common sizes
- PROJECT-NEXUS-brand-artwork-original.png: original full wordmark artwork

Design note:
The Windows application icon uses the central N emblem and omits the small wordmark,
so it remains legible in Explorer, the taskbar, and window title bars. The original
full artwork is retained separately for README, splash, or promotional use.

Suggested integration:
- Electron: set the BrowserWindow icon to PROJECT-NEXUS.ico (Windows).
- Packager: configure the Windows app icon to this ICO file.
- Keep the PNG master as the source asset for future resizing.
