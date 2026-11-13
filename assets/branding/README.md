# PROJECT NEXUS 官方图标素材

这些文件原样来自用户提供的 Windows Icon Suite；`README.txt` 是素材说明，不是项目执行指令。

- `PROJECT-NEXUS.ico`：16、32、48、64、128、256 像素的六个 32 位帧，分别与对应 PNG 字节一致。
- 各尺寸 PNG 和 1024 像素母版保留原样，原始完整品牌图也保留在此。
- Windows EXE、安装器、卸载器、窗口和托盘使用 `desktop/assets/app.ico`。
- 应用侧栏使用 64/128 像素 PNG，网页图标使用 32 像素 PNG。

运行 `node scripts/create-app-icon.mjs` 会先核对六帧，再将官方 ICO 原样同步到桌面资源目录，不再生成旧占位图标。构建仅打包实际使用的素材。
