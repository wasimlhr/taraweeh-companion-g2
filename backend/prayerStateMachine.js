/**
 * Prayer-aware state machine for backend.
 */
import { fuzzySearch, shouldLock } from './fuzzyMatcher.js';

const SURAH_AYAH_COUNTS = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111,
  110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45,
  83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55,
  78, 96, 29, 22, 12, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56,
  40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8,
  8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

const MISSED_BEFORE_PAUSED = 3;
const MISSED_BEFORE_LOST = 3;

const SURAH_NAMES = [
  'Al-Fatihah', 'Al-Baqarah', 'Al-Imran', 'An-Nisa', 'Al-Ma\'idah', 'Al-An\'am', 'Al-A\'raf', 'Al-Anfal', 'At-Tawbah', 'Yunus',
  'Hud', 'Yusuf', 'Ar-Ra\'d', 'Ibrahim', 'Al-Hijr', 'An-Nahl', 'Al-Isra', 'Al-Kahf', 'Maryam', 'Ta-Ha',
  'Al-Anbiya', 'Al-Hajj', 'Al-Mu\'minun', 'An-Nur', 'Al-Furqan', 'Ash-Shu\'ara', 'An-Naml', 'Al-Qasas', 'Al-Ankabut', 'Ar-Rum',
  'Luqman', 'As-Sajdah', 'Al-Ahzab', 'Saba', 'Fatir', 'Ya-Sin', 'As-Saffat', 'Sad', 'Az-Zumar', 'Ghafir',
  'Fussilat', 'Ash-Shura', 'Az-Zukhruf', 'Ad-Dukhan', 'Al-Jathiyah', 'Al-Ahqaf', 'Muhammad', 'Al-Fath', 'Al-Hujurat', 'Qaf',
  'Adh-Dhariyat', 'At-Tur', 'An-Najm', 'Al-Qamar', 'Ar-Rahman', 'Al-Waqi\'ah', 'Al-Hadid', 'Al-Mujadila', 'Al-Hashr', 'Al-Mumtahanah',
  'As-Saf', 'Al-Jumu\'ah', 'Al-Munafiqun', 'At-Taghabun', 'At-Talaq', 'At-Tahrim', 'Al-Mulk', 'Al-Qalam', 'Al-Haqqah', 'Al-Ma\'arij',
  'Nuh', 'Al-Jinn', 'Al-Muzzammil', 'Al-Muddaththir', 'Al-Qiyamah', 'Al-Insan', 'Al-Mursalat', 'An-Naba', 'An-Nazi\'at', 'Abasa',
  'At-Takwir', 'Al-Infitar', 'Al-Mutaffifin', 'Al-Inshiqaq', 'Al-Buruj', 'At-Tariq', 'Al-A\'la', 'Al-Ghashiyah', 'Al-Fajr', 'Al-Balad',
  'Ash-Shams', 'Al-Layl', 'Ad-Duha', 'Ash-Sharh', 'At-Tin', 'Al-Alaq', 'Al-Qadr', 'Al-Bayyinah', 'Az-Zalzalah', 'Al-Adiyat',
  'Al-Qari\'ah', 'At-Takathur', 'Al-Asr', 'Al-Humazah', 'Al-Fil', 'Quraysh', 'Al-Ma\'un', 'Al-Kawthar', 'Al-Kafirun', 'An-Nasr',
  'Al-Masad', 'Al-Ikhlas', 'Al-Falaq', 'An-Nas',
];

function getNextAyah(surah, ayah) {
  const count = SURAH_AYAH_COUNTS[surah - 1] ?? 0;
  if (ayah < count) return { surah, ayah: ayah + 1 };
  if (surah >= 114) return null;
  return { surah: surah + 1, ayah: 1 };
}

function getPrevAyah(surah, ayah) {
  if (ayah > 1) return { surah, ayah: ayah - 1 };
  if (surah <= 1) return null;
  const prevCount = SURAH_AYAH_COUNTS[surah - 2] ?? 0;
  return { surah: surah - 1, ayah: prevCount };
}

export function createState() {
  return {
    mode: 'SEARCHING',
    surah: 1,
    ayah: 1,
    confidence: 0,
    missedChunks: 0,
    resumingMissed: 0,
    lastMatch: null,
    nonQuranText: undefined,
  };
}

export function transition(state, event) {
  switch (event.type) {
    case 'RESET':
      return createState();

    case 'SILENCE':
      if (state.mode === 'LOCKED' || state.mode === 'RESUMING') {
        return { ...state, mode: 'PAUSED', nonQuranText: undefined };
      }
      return state;

    case 'NON_QURAN':
      return {
        ...state,
        mode: 'PAUSED',
        nonQuranText: event.text,
        nonQuranMeaning: event.meaning,
        nonQuranType: event.speechType,
      };

    case 'AUDIO_RETURN':
      if (state.mode === 'PAUSED') {
        return { ...state, mode: 'RESUMING', resumingMissed: 0 };
      }
      return state;

    case 'MANUAL_ADVANCE': {
      if (state.mode !== 'LOCKED') return state;
      const next = getNextAyah(state.surah, state.ayah);
      if (!next) return state;
      return { ...state, surah: next.surah, ayah: next.ayah, missedChunks: 0 };
    }

    case 'MANUAL_PREV': {
      if (state.mode !== 'LOCKED') return state;
      const prev = getPrevAyah(state.surah, state.ayah);
      if (!prev) return state;
      return { ...state, surah: prev.surah, ayah: prev.ayah, missedChunks: 0 };
    }

    case 'MATCH': {
      const { matches, lock } = event;
      if (matches.length === 0) {
        if (state.mode === 'LOCKED') {
          const missed = state.missedChunks + 1;
          if (missed >= MISSED_BEFORE_PAUSED) return { ...state, mode: 'PAUSED', missedChunks: 0 };
          return { ...state, missedChunks: missed };
        }
        if (state.mode === 'RESUMING') {
          const missed = state.resumingMissed + 1;
          if (missed >= MISSED_BEFORE_LOST) return { ...state, mode: 'LOST', resumingMissed: 0 };
          return { ...state, resumingMissed: missed };
        }
        return state;
      }

      const top = matches[0];
      const conf = Math.round(top.score * 100);

      if (state.mode === 'SEARCHING' && lock) {
        return { mode: 'LOCKED', surah: top.surah, ayah: top.ayah, confidence: conf, missedChunks: 0, resumingMissed: 0, lastMatch: top, nonQuranText: undefined };
      }

      if (state.mode === 'LOCKED') {
        const next = getNextAyah(state.surah, state.ayah);
        if (top.surah === state.surah && top.ayah === state.ayah) {
          return { ...state, confidence: conf, missedChunks: 0, lastMatch: top };
        }
        if (next && top.surah === next.surah && top.ayah === next.ayah) {
          return { ...state, surah: next.surah, ayah: next.ayah, confidence: conf, missedChunks: 0, lastMatch: top };
        }
        const missed = state.missedChunks + 1;
        if (missed >= MISSED_BEFORE_PAUSED) return { ...state, mode: 'PAUSED', missedChunks: 0 };
        return { ...state, missedChunks: missed };
      }

      if (state.mode === 'RESUMING' && lock) {
        return { mode: 'LOCKED', surah: top.surah, ayah: top.ayah, confidence: conf, missedChunks: 0, resumingMissed: 0, lastMatch: top, nonQuranText: undefined };
      }

      if (state.mode === 'RESUMING') {
        const missed = state.resumingMissed + 1;
        if (missed >= MISSED_BEFORE_LOST) return { ...state, mode: 'LOST', resumingMissed: 0 };
        return { ...state, resumingMissed: missed };
      }

      if (state.mode === 'LOST' && lock) {
        return { mode: 'LOCKED', surah: top.surah, ayah: top.ayah, confidence: conf, missedChunks: 0, resumingMissed: 0, lastMatch: top, nonQuranText: undefined };
      }

      return state;
    }

    default:
      return state;
  }
}

export function processWhisperResult(whisperText, state, options = {}) {
  const { topThreshold = 0.65, gapThreshold = 0.10, preferredSurah = 0 } = options;
  const matches = fuzzySearch(whisperText, 5, 0.3, preferredSurah);
  const lock = shouldLock(matches, topThreshold, gapThreshold);
  if (matches.length > 0) {
    console.log(`[Matcher] Top ${matches.length} candidates for "${whisperText.substring(0, 40)}":`);
    matches.slice(0, 3).forEach((m, i) =>
      console.log(`  ${i + 1}. ${m.surah}:${m.ayah} score=${m.score.toFixed(3)} "${m.arabic?.substring(0, 50)}"`)
    );
    console.log(`[Matcher] Lock=${lock} (top=${matches[0].score.toFixed(3)}, threshold=${topThreshold})`);
  } else {
    console.log(`[Matcher] No matches for "${whisperText.substring(0, 40)}"`);
  }
  const newState = transition(state, { type: 'MATCH', matches, lock });
  newState._matches = matches.slice(0, 3);
  newState._locked = lock;
  return newState;
}
