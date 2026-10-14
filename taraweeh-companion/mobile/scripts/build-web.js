#!/usr/bin/env node
/**
 * Build www/ for the standalone phone app from the one shared frontend,
 * app/index.html. Nothing is forked: the page switches itself into
 * standalone translator mode (phone mic in, phone screen out) when it sees the flag
 * injected here, or a native Capacitor runtime.
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcHtml = join(mobileDir, '..', 'app', 'index.html');
const outDir = join(mobileDir, 'www');

const VIEWPORT_OLD = '<meta name="viewport" content="width=device-width, initial-scale=1.0" />';
const VIEWPORT_NEW = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />';
// Ad units for the bottom banner. Without real IDs in the environment the
// build uses Google's public test units, which only ever serve test ads.
const TEST_BANNER_ANDROID = 'ca-app-pub-3940256099942544/9214589741';
const TEST_BANNER_IOS = 'ca-app-pub-3940256099942544/2435281174';
export const ADS_CONFIG = {
  enabled: process.env.ADS_ENABLED !== '0',
  bannerAndroid: process.env.ADMOB_BANNER_ANDROID || TEST_BANNER_ANDROID,
  bannerIos: process.env.ADMOB_BANNER_IOS || TEST_BANNER_IOS,
  testing: !(process.env.ADMOB_BANNER_ANDROID || process.env.ADMOB_BANNER_IOS),
};

export const HEAD_INJECT = [
  '<script>window.__QURAN_TRANSLATOR_STANDALONE__ = true; window.__TARAWEEH_STANDALONE__ = true;'
    + ' window.__QVT_ADS__ = ' + JSON.stringify(ADS_CONFIG) + ';</script>',
  '<script src="capacitor.js"></script>',
].join('\n  ');

export function transformHtml(html) {
  if (!html.includes(VIEWPORT_OLD)) throw new Error('viewport meta not found in app/index.html');
  if (!html.includes('</head>')) throw new Error('</head> not found in app/index.html');
  return html
    .replace(VIEWPORT_OLD, VIEWPORT_NEW)
    .replace('</head>', '  ' + HEAD_INJECT + '\n</head>');
}

export function build() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), transformHtml(readFileSync(srcHtml, 'utf8')));
  copyFileSync(join(dirname(srcHtml), 'readerPagination.js'), join(outDir, 'readerPagination.js'));
  copyFileSync(join(dirname(srcHtml), 'readerArtwork.js'), join(outDir, 'readerArtwork.js'));
  cpSync(join(dirname(srcHtml),'artwork'),join(outDir,'artwork'),{recursive:true});
  // Settings links to the privacy policy, so it ships inside the app too.
  copyFileSync(join(dirname(srcHtml), 'privacy.html'), join(outDir, 'privacy.html'));
  mkdirSync(join(outDir, 'fonts'), { recursive: true });
  copyFileSync(join(dirname(srcHtml), 'fonts', 'AmiriQuran.ttf'), join(outDir, 'fonts', 'AmiriQuran.ttf'));
  copyFileSync(join(dirname(srcHtml), 'fonts', 'OFL.txt'), join(outDir, 'fonts', 'OFL.txt'));
  for(const file of ['DigitalKhattIndoPak.otf','IndoPak-OFL.txt'])copyFileSync(join(dirname(srcHtml),'fonts',file),join(outDir,'fonts',file));
  copyFileSync(join(dirname(srcHtml), 'privacy.html'), join(outDir, 'privacy.html'));
  // IIFE build of @capacitor/core: gives the plain <script> page registerPlugin.
  const require = createRequire(import.meta.url);
  const coreDist = dirname(require.resolve('@capacitor/core/dist/capacitor.js'));
  copyFileSync(join(coreDist, 'capacitor.js'), join(outDir, 'capacitor.js'));
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('www built at ' + build());
}
