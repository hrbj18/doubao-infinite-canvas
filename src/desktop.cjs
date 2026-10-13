const electron = require('electron');
const path = require('node:path');
const { Studio } = require('./core.cjs');
const { PlatformAdapter } = require('./platform.cjs');
const { startServer } = require('./server.cjs');
const { seed } = require('./seed.cjs');
const { app, BrowserWindow } = electron;
app.setName('CanvasStudio');
const data = process.env.STUDIO_DATA || path.join(app.getPath('appData'), 'CanvasStudio');
app.setPath('userData', path.join(data, 'browser'));
let main, server, interval, platform, shuttingDown = false, quitReady = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { main?.show(); main?.focus(); });
  app.whenReady().then(async () => {
    const studio = new Studio(data); seed(studio);
    platform = new PlatformAdapter(studio, electron); studio.adapter = platform; studio.recover();
    const backend = await startServer(studio, { desktop: platform }); server = backend.server;
    main = new BrowserWindow({ title: 'Canvas Studio · 豆包 / Dola', width: 1540, height: 960, minWidth: 1100, minHeight: 700, backgroundColor: '#11171c', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    main.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(backend.url + '/')) event.preventDefault(); });
    main.on('closed', () => app.quit()); await main.loadURL(backend.url);
    interval = setInterval(() => void studio.tick(), 3000); void studio.tick();
  }).catch(error => { electron.dialog.showErrorBox('启动失败', error.message); app.quit(); });
  app.on('before-quit', event => {
    clearInterval(interval); server?.close();
    if (platform && !quitReady) { event.preventDefault(); if (!shuttingDown) { shuttingDown = true; void platform.cookieAccounts.flush().finally(() => { quitReady = true; app.quit(); }); } }
  });
  app.on('window-all-closed', () => app.quit());
}
