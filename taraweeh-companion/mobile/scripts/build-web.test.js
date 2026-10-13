import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { build, transformHtml, HEAD_INJECT, ADS_CONFIG } from './build-web.js';

test('www is the shared frontend plus the standalone flag, nothing else', () => {
  const out = build();
  const src = readFileSync(join(out, '..', '..', 'app', 'index.html'), 'utf8');
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(html.includes('window.__QURAN_TRANSLATOR_STANDALONE__ = true'));
  assert.ok(html.includes('viewport-fit=cover'));
  assert.ok(html.includes('window.__QVT_ADS__ = {'));
  assert.ok(html.indexOf('capacitor.js') < html.indexOf('</head>'));
  assert.ok(existsSync(join(out, 'capacitor.js')));
  assert.ok(existsSync(join(out, 'fonts', 'AmiriQuran.ttf')));
  assert.ok(existsSync(join(out, 'fonts', 'OFL.txt')));
  assert.ok(existsSync(join(out, 'privacy.html')));
  assert.ok(existsSync(join(out, 'privacy.html')));
  const undone = html
    .replace('  ' + HEAD_INJECT + '\n', '')
    .replace(', viewport-fit=cover', '');
  assert.equal(undone, src);
});

test('the page knows standalone mode and skips the G2 bridge probe', () => {
  const src = readFileSync(new URL('../../app/index.html', import.meta.url), 'utf8');
  assert.match(src, /window\.__QURAN_TRANSLATOR_STANDALONE__ === true/);
  assert.match(src, /if \(IS_STANDALONE\) setupStandalone\(\);\s*else await detectBridge\(\);/);
});

test('a frontend without the expected anchors fails the build loudly', () => {
  assert.throws(() => transformHtml('<html><head></head></html>'), /viewport meta/);
});

test('without real ad IDs the build only ever uses Google test units', () => {
  if (process.env.ADMOB_BANNER_ANDROID || process.env.ADMOB_BANNER_IOS) return;
  assert.equal(ADS_CONFIG.testing, true);
  assert.match(ADS_CONFIG.bannerAndroid, /^ca-app-pub-3940256099942544\//);
  assert.match(ADS_CONFIG.bannerIos, /^ca-app-pub-3940256099942544\//);
});

test('the banner stays out of Taraweeh mode and never covers the page', () => {
  const src = readFileSync(new URL('../../app/index.html', import.meta.url), 'utf8');
  assert.match(src, /var want = !_taraweehMode;/);
  assert.match(src, /var\(--ad-h, 0px\)/);
  assert.doesNotMatch(src, /showInterstitial|showRewardVideoAd|showAppOpen/);
});

test('the phone shell docks Start, swipes ayahs and treats a missing key as setup', () => {
  const src = readFileSync(new URL('../../app/index.html', import.meta.url), 'utf8');
  assert.match(src, /setupMobileShell\(\);\s*setupAds\(\);/);
  assert.match(src, /if \(next\) manualNextAyah\(\); else manualPrevAyah\(\);/);
  assert.match(src, /<div id="qvtDock">/);
  assert.match(src, /if \(IS_STANDALONE && !hasKey\)/);
});
