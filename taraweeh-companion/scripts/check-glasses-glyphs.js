#!/usr/bin/env node
/**
 * Every character the app sends to the glasses must exist in the firmware font.
 *
 * A missing glyph is invisible rather than loud: LVGL draws nothing and the
 * line silently loses a character, so "✓ Al-Baqarah complete" shipped for
 * months as " Al-Baqarah complete". @evenrealities/pretext embeds the same
 * font tables the firmware uses, and reports a zero advance width for a
 * codepoint it has no glyph for — which is exactly the test.
 *
 *   node scripts/check-glasses-glyphs.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let getAdvW;
try {
  ({ getAdvW } = await import('@evenrealities/pretext'));
} catch (_) {
  console.error('check-glasses-glyphs: @evenrealities/pretext is not installed — run npm install');
  process.exit(1);
}

const html = readFileSync(join(root, 'app', 'index.html'), 'utf8');

/**
 * Decode the \uXXXX escapes the app uses for non-ASCII so they are checked as
 * the characters the glasses will actually receive.
 */
function unescapeJs(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Literals that end up in a glasses container, gathered from the places that
// build them. Anything routed only to the DOM is out of scope — a phone
// renders the full Unicode range.
const GLASSES_SOURCES = [
  // Status markers and the fixed strings in buildGlassesText / the startup page.
  ...html.matchAll(/G2_MARK_[A-Z]+\s*=\s*'([^']*)'/g),
  ...html.matchAll(/\bhdr:\s*'([^']*)'/g),
  ...html.matchAll(/\bpages:\s*\['([^']*)'\]/g),
  ...html.matchAll(/return \{ hdr: '([^']*)'/g),
  ...html.matchAll(/function _startupBodyText\(\) \{[\s\S]*?\n  \}/g),
  ...html.matchAll(/function appTitleHdr\(\) \{ return '([^']*)'; \}/g),
  // Posture names: `chip` and `latin` are both drawn on the glasses.
  ...html.matchAll(/\blatin:\s*'([^']*)'/g),
  ...html.matchAll(/\bchip:\s*"([^"]*)"/g),
  ...html.matchAll(/\bchip:\s*'([^']*)'/g),
];

const chars = new Map();   // char → sample context
for (const m of GLASSES_SOURCES) {
  const text = unescapeJs(m[1] ?? m[0]);
  for (const ch of text) {
    if (ch === '\n' || ch === '\\') continue;
    if (!chars.has(ch)) chars.set(ch, text.slice(0, 48));
  }
}

const missing = [];
for (const [ch, context] of chars) {
  if (getAdvW(ch.codePointAt(0)) === 0) {
    missing.push({ ch, cp: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'), context });
  }
}

console.log(`check-glasses-glyphs: ${chars.size} distinct characters reach the glasses`);
if (missing.length) {
  console.error('\nThese have no glyph in the G2 firmware font and will render as nothing:\n');
  for (const m of missing) console.error(`  ${m.cp}  "${m.ch}"  in: ${m.context}`);
  process.exit(1);
}
console.log('check-glasses-glyphs: every one of them has a glyph');
