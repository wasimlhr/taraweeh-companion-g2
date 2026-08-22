/**
 * Shared Whisper transcript cleanup used by AudioPipeline V4 and YouTube replay.
 * Keep this in lockstep with live search: isti'adha / bismillah prefixes must
 * not reach the matcher (16:98 / 1:1 false locks).
 */
import { stripWhisperPromptEcho } from './whisperPrompt.js';

const NOISE_WORDS = new Set([
  'موسيقى', 'تبا', 'تباً', 'هممم', 'همم', 'مممم', 'ممم',
  'music', 'applause', 'laughter', 'silence',
  'اشترك', 'للاشتراك',
  'مرحبا', 'مرحباً', 'اهلا', 'أهلاً', 'اهلاً',
  'صباح', 'مساء',
  'شكرا', 'شكراً',
  'نانسي', 'قنقر',
  'تلاوة',
]);
const NOISE_PHRASES = [
  'مرحبا بك', 'مرحباً بك', 'أهلا بك', 'اهلا بك',
  'صباح الخير', 'مساء الخير', 'كيف حالك',
  'شكرا لكم', 'ترجمه لكي', 'توقف عن الاشتراك', 'ماذا يفعلون',
  'اشتركوا في القناة', 'اشتركوا في', 'اشترك في القناة',
  'شكرا للمشاهدة', 'شكرا لمشاهدتكم',
  'يا عمار',
];

const QURAN_MARKS_RE = /[\u064B-\u065F\u0610-\u061A\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0615\u0652\u06D9\uFE70-\uFEFF]/g;
const BISMILLAH_NORM_RE = /^بسم\s+الله\s+الرحمن\s+الرحيم[\s\u06D9\u060C]*/;
// Leading isti'adha only (the recitation preamble). Do not match mid-verse
// "الشيطان الرجيم" (16:98, 7:200) — those are Quran, not a skip cue.
const ISTI_ADHA_PREFIX_RE = /^(اعوذ|أعوذ)\s+بالله(\s+من)?(\s+الشيطان)?(\s+الرجيم)?[\s.،,]*/;

const AMEEN_RE = /^(آمين|أمين|امين)(\s+(آمين|أمين|امين))*$/;

function normalizeMarks(text) {
  return String(text || '').replace(QURAN_MARKS_RE, '').replace(/\s+/g, ' ').trim();
}

export function cleanWhisperText(text) {
  let t = String(text || '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/^[\[\(]+|[\]\)]+$/g, '')
    .replace(/^>+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^(شكرا|شكراً|ترجمة[^\s]*)\s*/g, '').trim();
  t = stripWhisperPromptEcho(t);
  return t;
}

export function stripIstiAdhaPrefix(text) {
  const norm = normalizeMarks(text);
  const match = norm.match(ISTI_ADHA_PREFIX_RE);
  if (!match) return norm;
  const remainder = norm.slice(match[0].length).trim();
  if (remainder.length < 3) return norm;
  console.log(`[Pipeline] Stripped isti'adha prefix → "${remainder.substring(0, 60)}"`);
  return remainder;
}

export function stripBismillahPrefix(text) {
  const norm = normalizeMarks(text);
  const match = norm.match(BISMILLAH_NORM_RE);
  if (!match) return norm;
  const remainder = norm.slice(match[0].length).trim();
  if (remainder.length < 5) return norm;
  console.log(`[Pipeline] Stripped bismillah prefix → "${remainder.substring(0, 60)}"`);
  return remainder;
}

export function isBismillahOnly(text) {
  if (!text || !String(text).trim()) return false;
  const norm = normalizeMarks(text);
  const match = norm.match(BISMILLAH_NORM_RE);
  if (!match) return false;
  return norm.slice(match[0].length).trim().length < 5;
}

export function isIstiAdhaOnly(text) {
  if (!text || !String(text).trim()) return false;
  const norm = normalizeMarks(text);
  const match = norm.match(ISTI_ADHA_PREFIX_RE);
  if (!match) return false;
  return norm.slice(match[0].length).trim().length < 3;
}

/** True only when the chunk is the preamble itself, not a verse that quotes it. */
export function isPreRecitationPhrase(text) {
  return isIstiAdhaOnly(text);
}

export function isPreambleOnly(text) {
  return isIstiAdhaOnly(text) || isBismillahOnly(text);
}

export function isAmeen(text) {
  if (!text) return false;
  return AMEEN_RE.test(String(text).replace(/[\u064b-\u065f\u0670]/g, '').trim());
}

export function isNoise(text) {
  if (!text || text.trim().length < 2) return true;
  const n = text.replace(/[\u064B-\u065F]/g, '').trim();
  if (!/[\u0600-\u06FF]/.test(n)) return true;
  if (/^[a-zA-Z0-9\s.,!?]+$/.test(n)) return true;
  if (/(.)\1{10,}/.test(n)) return true;
  if (NOISE_PHRASES.some(p => n.startsWith(p))) return true;
  const words = n.split(/\s+/);
  if (words.length <= 2 && words.every(w => NOISE_WORDS.has(w))) return true;
  return false;
}

/**
 * Live-pipeline cleanup: drop caption junk, leading isti'adha, then leading bismillah.
 * Remainder is what the matcher / lock SM should see.
 */
export function prepareMatcherText(raw) {
  let t = cleanWhisperText(raw);
  t = stripIstiAdhaPrefix(t);
  t = stripBismillahPrefix(t);
  return t;
}
