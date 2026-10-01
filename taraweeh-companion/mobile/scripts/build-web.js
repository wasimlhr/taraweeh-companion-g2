#!/usr/bin/env node
/**
 * Build www/ for the standalone phone app from the one shared frontend,
 * app/index.html. Nothing is forked: the page switches itself into
 * standalone mode (phone mic in, phone screen out) when it sees the flag
 * injected here, or a native Capacitor runtime.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcHtml = join(mobileDir, '..', 'app', 'index.html');
const outDir = join(mobileDir, 'www');

const VIEWPORT_OLD = '<meta name="viewport" content="width=device-width, initial-scale=1.0" />';
const VIEWPORT_NEW = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />';
export const HEAD_INJECT = [
  '<script>window.__TARAWEEH_STANDALONE__ = true;</script>',
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
  // IIFE build of @capacitor/core: gives the plain <script> page registerPlugin.
  const require = createRequire(import.meta.url);
  const coreDist = dirname(require.resolve('@capacitor/core/dist/capacitor.js'));
  copyFileSync(join(coreDist, 'capacitor.js'), join(outDir, 'capacitor.js'));
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('www built at ' + build());
}
