#!/usr/bin/env node
import { networkInterfaces } from 'os';
import { createRequire } from 'module';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const appUrl = process.env.APP_URL || process.argv[2];
const httpPort = process.env.PORT || 3001;
const httpsPort = process.env.HTTPS_PORT || 3443;
let ip = null;

let url;
if (appUrl) {
  url = appUrl.startsWith('http') ? appUrl : `https://${appUrl}`;
} else {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
      }
      if (ip) break;
    }
  } catch {}
  url = ip ? `https://${ip}:${httpsPort}` : `http://localhost:${httpPort}`;
}

const QRCode = require('qrcode');
console.log('\n  ' + url + '\n');
QRCode.toString(url, { type: 'terminal', small: true }, function(err, qr) {
  if (err) { console.error('QR error:', err); process.exit(1); }
  console.log(qr);
});
