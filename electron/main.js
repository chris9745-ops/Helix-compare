const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');

let mainWindow;
let serverReady;

// Start the embedded server exactly once. On macOS the app stays alive after
// its window closes and createWindow() runs again on Dock click — that must
// reuse the running server, not try to bind the port a second time.
function ensureServer() {
  if (!serverReady) {
    // Store connections outside the app bundle so they survive updates/reinstalls.
    process.env.HELIX_DATA_DIR = path.join(app.getPath('userData'), 'data');
    const { start } = require('../server/index.js');
    serverReady = start();
  }
  return serverReady;
}

async function createWindow() {
  try {
    await ensureServer();
  } catch (err) {
    dialog.showErrorBox(
      'Helix Dev Tool could not start',
      err.code === 'EADDRINUSE'
        ? 'Port 3001 is already in use. Another copy of Helix Dev Tool (or a dev server) may be running — quit it and try again.'
        : String(err.message || err)
    );
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Helix Dev Tool',
    backgroundColor: '#0f0f10',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('http://localhost:3001');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
