#!/usr/bin/env node
/**
 * Generate QR code for the app URL (Railway, custom URL, or local IP).
 * Usage:
 *   node scripts/qr-web-url.js [URL] [--png [path]]
 *   APP_URL=https://... node scripts/qr-web-url.js
 *   npm run qr:railway   → uses https://taraweeh.up.railway.app and saves qr-railway.png
 */
import { networkInterfaces } from 'os';
import { createRequire } from 'module';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const argv = process.argv.slice(2);
const pngIdx = argv.indexOf('--png');
const savePng = pngIdx !== -1;
const pngPath = savePng && argv[pngIdx + 1] && !argv[pngIdx + 1].startsWith('-')
  ? argv[pngIdx + 1]
  : (savePng ? resolve(__dirname, '..', 'qr-railway.png') : null);
const urlArg = argv.filter((a, i) => a !== '--png' && (i < pngIdx || i > pngIdx + 1) && !a.startsWith('-'))[0];

const appUrl = process.env.APP_URL || urlArg;
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

function done(err) {
  if (err) {
    console.error('QR error:', err);
    process.exit(1);
  }
}

QRCode.toString(url, { type: 'terminal', small: true }, function (err, qr) {
  if (err) return done(err);
  console.log(qr);
  if (pngPath) {
    QRCode.toFile(pngPath, url, { width: 400, margin: 2 }, function (fileErr) {
      if (fileErr) return done(fileErr);
      console.log('Saved QR image: ' + pngPath);
    });
  }
});
