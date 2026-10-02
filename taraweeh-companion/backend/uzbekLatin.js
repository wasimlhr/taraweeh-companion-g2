/**
 * Official Uzbek Cyrillic → Latin (1995/2019), using the same quotation
 * marks as Alauddin Mansour's published Latin (o‘ / g‘ with U+2018,
 * ъ as U+2019). The G2 font has those quotes; it does not have Ғ Қ Ҳ.
 */

const MAP = {
  А: 'A', а: 'a',
  Б: 'B', б: 'b',
  В: 'V', в: 'v',
  Г: 'G', г: 'g',
  Ғ: 'G‘', ғ: 'g‘',
  Д: 'D', д: 'd',
  Ё: 'Yo', ё: 'yo',
  Ж: 'J', ж: 'j',
  З: 'Z', з: 'z',
  И: 'I', и: 'i',
  Й: 'Y', й: 'y',
  К: 'K', к: 'k',
  Қ: 'Q', қ: 'q',
  Л: 'L', л: 'l',
  М: 'M', м: 'm',
  Н: 'N', н: 'n',
  О: 'O', о: 'o',
  П: 'P', п: 'p',
  Р: 'R', р: 'r',
  С: 'S', с: 's',
  Т: 'T', т: 't',
  У: 'U', у: 'u',
  Ў: 'O‘', ў: 'o‘',
  Ф: 'F', ф: 'f',
  Х: 'X', х: 'x',
  Ҳ: 'H', ҳ: 'h',
  Ц: 'Ts', ц: 'ts',
  Ч: 'Ch', ч: 'ch',
  Ш: 'Sh', ш: 'sh',
  Щ: 'Sh', щ: 'sh',
  Ъ: '’', ъ: '’',
  Ь: '', ь: '',
  Э: 'E', э: 'e',
  Ю: 'Yu', ю: 'yu',
  Я: 'Ya', я: 'ya',
};

const VOWELS = /[аеиоуўэюяАЕИОУЎЭЮЯaeiouAEIOU]/;
const YE_BEFORE = /[\s(\-«"“]/;

export function cyrillicToUzbekLatin(text) {
  const s = String(text || '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === 'Е' || ch === 'е') {
      const prev = i === 0 ? ' ' : s[i - 1];
      const ye = i === 0 || YE_BEFORE.test(prev) || VOWELS.test(prev);
      out += ch === 'Е' ? (ye ? 'Ye' : 'E') : (ye ? 'ye' : 'e');
    } else if (Object.prototype.hasOwnProperty.call(MAP, ch)) {
      out += MAP[ch];
    } else {
      out += ch;
    }
  }
  return out;
}
