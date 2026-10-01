import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { build, transformHtml, HEAD_INJECT } from './build-web.js';

test('www is the shared frontend plus the standalone flag, nothing else', () => {
  const out = build();
  const src = readFileSync(join(out, '..', '..', 'app', 'index.html'), 'utf8');
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(html.includes('window.__TARAWEEH_STANDALONE__ = true'));
  assert.ok(html.includes('viewport-fit=cover'));
  assert.ok(html.indexOf('capacitor.js') < html.indexOf('</head>'));
  assert.ok(existsSync(join(out, 'capacitor.js')));
  const undone = html
    .replace('  ' + HEAD_INJECT + '\n', '')
    .replace(', viewport-fit=cover', '');
  assert.equal(undone, src);
});

test('the page knows standalone mode and skips the G2 bridge probe', () => {
  const src = readFileSync(new URL('../../app/index.html', import.meta.url), 'utf8');
  assert.match(src, /window\.__TARAWEEH_STANDALONE__ === true/);
  assert.match(src, /if \(IS_STANDALONE\) setupStandalone\(\);\s*else await detectBridge\(\);/);
});

test('a frontend without the expected anchors fails the build loudly', () => {
  assert.throws(() => transformHtml('<html><head></head></html>'), /viewport meta/);
});
