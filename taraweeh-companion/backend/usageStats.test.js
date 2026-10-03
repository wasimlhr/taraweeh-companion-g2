import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageStats, renderAnalyticsHtml } from './usageStats.js';

test('usage stats count connections, inits, and unique installs', () => {
  const stats = new UsageStats({ now: () => 1_000 });
  stats.connected({ concurrent: 1, sessionId: 'sid-a' });
  stats.connected({ concurrent: 2, sessionId: 'sid-b' });
  stats.connected({ concurrent: 1, sessionId: 'sid-a' });
  stats.init({ sessionId: 'sid-a', lang: 'uz', provider: 'groq', audioSource: 'g2', practiceMode: true, pipeline: 'v4', appVersion: 'v3.4.8' });
  stats.init({ sessionId: 'sid-b', lang: '', provider: 'openai', audioSource: 'browser', practiceMode: false, pipeline: 'v3', appVersion: 'v3.4.8' });
  stats.start();
  stats.error('gsk_SECRETvalue missing', 'key');
  stats.langPack({ lang: 'uzc', ok: true });
  const snap = stats.snapshot({ concurrent: 1 });
  assert.equal(snap.live.connections, 1);
  assert.equal(snap.live.peakConnections, 2);
  assert.equal(snap.live.uniqueInstalls, 2);
  assert.equal(snap.totals.inits, 2);
  assert.equal(snap.totals.listenStarts, 1);
  assert.equal(snap.totals.errors, 1);
  assert.equal(snap.using.translation[0].name, 'uz');
  assert.equal(snap.using.pipeline.find((x) => x.name === 'v4').count, 1);
  assert.ok(snap.errors[0].name.includes('gsk_…'));
  assert.doesNotMatch(snap.errors[0].name, /SECRETvalue/);
  const html = renderAnalyticsHtml(snap);
  assert.match(html, /Installs seen/);
  assert.match(html, />uz</);
});

test('usage event allowlist ignores unknown client events', () => {
  const stats = new UsageStats();
  assert.equal(stats.event({ event: 'lang_pack', lang: 'fr', ok: true }), true);
  assert.equal(stats.event({ event: 'drop_audio_here', pcm: 'nope' }), false);
  assert.equal(stats.event({ event: 'connect' }), false);
  assert.equal(stats.event({ event: 'start' }), false);
  assert.equal(stats.snapshot().totals.languagePacks, 1);
  assert.equal(stats.snapshot().totals.listenStarts, 0);
});

test('analytics HTML escapes error text and never echoes secrets', () => {
  const stats = new UsageStats({ now: () => 1_000 });
  stats.error('Bearer gsk_SECRETvalue <script>alert(1)</script>', 'client');
  const html = renderAnalyticsHtml(stats.snapshot());
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /SECRETvalue/);
  assert.match(html, /gsk_…|Bearer …/);
});
