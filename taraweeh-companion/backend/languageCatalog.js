import {readFileSync} from 'node:fs';
export const LANGUAGE_CATALOG = JSON.parse(readFileSync(new URL('./data/language-catalog.json',import.meta.url),'utf8')).languages;
export const LANGUAGE_CODES = LANGUAGE_CATALOG.map(e=>e.code);
export const PACK_CODES = [...new Set(LANGUAGE_CATALOG.map(e=>e.pack || e.code))];
export const GLASSES_FALLBACK_CODES = LANGUAGE_CATALOG.filter(e=>!e.glasses).map(e=>e.code);
