#!/usr/bin/env node
/**
 * Launch the EvenHub G2 simulator against the local backend.
 * Downloads the latest simulator on first run if it is not installed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://localhost:3001';
const require = createRequire(join(root, 'package.json'));

function resolveSimulatorBin() {
  try {
    const pkgJson = require.resolve('@evenrealities/evenhub-simulator/package.json');
    const pkg = require(pkgJson);
    const binRel = typeof pkg.bin === 'string'
      ? pkg.bin
      : (pkg.bin && (pkg.bin['evenhub-simulator'] || Object.values(pkg.bin)[0]));
    if (!binRel) return null;
    const binPath = join(dirname(pkgJson), binRel);
    return existsSync(binPath) ? binPath : null;
  } catch {
    return null;
  }
}

let bin = resolveSimulatorBin();
if (!bin) {
  console.log('EvenHub simulator not installed — downloading latest…');
  const install = spawnSync('npm', ['install', '--save-dev', '--no-fund', '--no-audit', '@evenrealities/evenhub-simulator@latest'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
  bin = resolveSimulatorBin();
}

if (!bin) {
  console.error('Could not locate evenhub-simulator binary. Try: npm run evenhub:download');
  process.exit(1);
}

console.log(`Launching EvenHub simulator → ${url}`);
const child = spawn(process.execPath, [bin, url, ...process.argv.slice(3)], {
  cwd: root,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
