const config = {
  appId: 'com.cloudflare.r2browser',
  appName: 'R2 Browser',
  webDir: 'www',
  server: {
    url: 'https://r2-browser.geminikil00.workers.dev',
    cleartext: true,
    allowNavigation: ['*'],
  },
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
  },
};

module.exports = config;
