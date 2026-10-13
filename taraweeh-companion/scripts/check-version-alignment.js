#!/usr/bin/env node
/** Every shipped version label must be the same app version. */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..');
const EXPECTED = '3.4.18';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const checks = [
  ['repo package.json', readJson(join(repo, 'package.json')).version],
  ['repo package-lock.json', readJson(join(repo, 'package-lock.json')).version],
  ['app package.json', readJson(join(root, 'package.json')).version],
  ['app package-lock.json', readJson(join(root, 'package-lock.json')).version],
  ['app.json', readJson(join(root, 'app.json')).version],
  ['backend package.json', readJson(join(root, 'backend/package.json')).version],
  ['backend package-lock.json', readJson(join(root, 'backend/package-lock.json')).version],
  ['phone package.json', readJson(join(root, 'mobile/package.json')).version],
  ['phone package-lock.json', readJson(join(root, 'mobile/package-lock.json')).version],
];
const android = readFileSync(join(root, 'mobile/android/app/build.gradle'), 'utf8').match(/versionName "([^"]+)"/);
checks.push(['Android version', android && android[1]]);
const ios = readFileSync(join(root, 'mobile/ios/App/App.xcodeproj/project.pbxproj'), 'utf8').matchAll(/MARKETING_VERSION = ([^;]+);/g);
for (const match of ios) checks.push(['iOS version', match[1]]);
for (const location of [repo, root]) {
  if (readJson(join(location, 'package.json')).dependencies['@evenrealities/even_hub_sdk'] !== '0.0.16') {
    console.error('FAIL SDK version must be pinned to 0.0.16 in both packages'); process.exit(1);
  }
}
const serverBanner = readFileSync(join(root, 'backend/server.js'), 'utf8').match(/\* v([0-9.]+)/);
checks.push(['server.js banner', serverBanner && serverBanner[1]]);

const html = readFileSync(join(root, 'app/index.html'), 'utf8');
const appVer = html.match(/const APP_VERSION = 'v([^']+)'/);
const elVer = html.match(/id="versionEl">v([^<]+)</);
checks.push(['index.html APP_VERSION', appVer && appVer[1]]);
checks.push(['index.html versionEl', elVer && elVer[1]]);

const labelFn = html.match(/function providerLabel\(p\) \{[\s\S]*?\n  \}/);
if (!labelFn) {
  console.error('FAIL providerLabel missing');
  process.exit(1);
}
if (/sanitizeProvider\(p\)/.test(labelFn[0]) || /\|\| 'groq'/.test(labelFn[0]) || /: 'OpenAI'/.test(labelFn[0])) {
  console.error('FAIL providerLabel still defaults unknown engines to Groq/OpenAI\n', labelFn[0]);
  process.exit(1);
}
if (!labelFn[0].includes("return p ? p : 'Engine'")) {
  console.error('FAIL providerLabel must label unknown engines as Engine\n', labelFn[0]);
  process.exit(1);
}

let failed = false;
for (const [name, ver] of checks) {
  if (ver !== EXPECTED) {
    console.error(`FAIL ${name}: ${ver} (want ${EXPECTED})`);
    failed = true;
  } else {
    console.log(`ok  ${name}: ${ver}`);
  }
}
if (failed) process.exit(1);
console.log('ok  all shipped versions are', EXPECTED);
