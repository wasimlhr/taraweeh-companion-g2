#!/usr/bin/env node
/**
 * Kill any process using port 3001 (Windows).
 * Run: node scripts/kill-port-3001.js
 */
import { execSync } from 'child_process';

try {
  const out = execSync('netstat -ano | findstr :3001', { encoding: 'utf8', maxBuffer: 1024 });
  const lines = out.trim().split('\n').filter(Boolean);
  const pids = new Set();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'inherit' });
    console.log(`Killed PID ${pid}`);
  }
  if (pids.size === 0) console.log('No process found on port 3001');
} catch (e) {
  if (e.status === 1) {
    console.log('No process found on port 3001');
  } else {
    throw e;
  }
}
