// Sözlük modülü — boot'ta data/words.tr.json yükler ve iki index inşa eder:
//   1. Set<String>            → O(1) kelime doğrulama (validateWord)
//   2. Map<sortedKey, word[]> → anagram index (puzzle çözüm hesabı)
// Sözlük client'a ASLA gönderilmez — sadece submit/ack (plan anti-cheat kuralı).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { turkceLower, isGameWord } from './turkce.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WORDS_PATH = path.join(ROOT, config.PATHS.WORDS);

let words = [];
let wordSet = new Set();
let anagramIndex = new Map();
let letterCounts = new Map();
const byLengthCache = new Map();

export let ready = false;

function ensureLoaded() {
  if (!ready) throw new Error('Sözlük yüklenmedi — önce loadDictionary() çağırın');
}

/**
 * Sözlüğü (yeniden) yükler. Testler farklı dosya vermek için path parametresi kullanır.
 * @returns {{count: number}} yüklenen kelime sayısı
 */
export function loadDictionary(filePath = DEFAULT_WORDS_PATH) {
  const arr = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`Geçersiz sözlük dosyası: ${filePath}`);
  }

  words = arr;
  wordSet = new Set(arr);
  anagramIndex = new Map();
  letterCounts = new Map();
  byLengthCache.clear();

  for (const w of arr) {
    const key = [...w].sort().join('');
    const bucket = anagramIndex.get(key);
    if (bucket) bucket.push(w);
    else anagramIndex.set(key, [w]);
    for (const ch of w) letterCounts.set(ch, (letterCounts.get(ch) ?? 0) + 1);
  }

  ready = true;
  return { count: words.length };
}

export function isReady() {
  return ready;
}

/**
 * Gelen kelimeyi Türkçe-aware normalize edip doğrular.
 * Sonuç objesi Faz 2'de word:submit ack payload'ına aynen taşınabilir.
 * @returns {{ok: boolean, word?: string, reason?: 'invalid'|'format'|'not_in_dictionary'}}
 */
export function validateWord(input) {
  ensureLoaded();
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  const norm = turkceLower(input);
  if (!isGameWord(norm)) {
    return { ok: false, reason: 'format', word: norm };
  }
  return wordSet.has(norm)
    ? { ok: true, word: norm }
    : { ok: false, reason: 'not_in_dictionary', word: norm };
}

/**
 * Harf çokluğunun tüm alt-çokluklarını (3..6 harf) anagram index'te arar.
 * 6 harf → ≤63 maske → birkaç yüz key lookup, O(1) Map erişimi.
 * @param {string[]} letters harf dizisi (kopya harf içerebilir)
 * @returns {string[]} sözlükteki tüm geçerli kelimeler (sorted, unique)
 */
export function solutionsForLetters(letters) {
  ensureLoaded();
  const arr = (letters ?? []).map((c) => turkceLower(String(c)));
  const n = arr.length;
  if (n === 0) return [];

  const keys = new Set();
  for (let mask = 1; mask < 1 << n; mask++) {
    const sel = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) sel.push(arr[i]);
    }
    if (sel.length >= config.WORD.MIN_LENGTH && sel.length <= config.WORD.MAX_LENGTH) {
      keys.add(sel.sort().join(''));
    }
  }

  const out = new Set();
  for (const k of keys) {
    const bucket = anagramIndex.get(k);
    if (bucket) for (const w of bucket) out.add(w);
  }
  return [...out].sort();
}

/**
 * Harf başına geçiş oranı (kelime listesinden hesaplanır — harici frekans tablosu YOK).
 * Puzzle üretiminin frekans-ağırlıklı yolu bunu kullanır.
 * @returns {Map<string, number>} harf → oran
 */
export function letterFrequencies() {
  ensureLoaded();
  let total = 0;
  for (const n of letterCounts.values()) total += n;
  const out = new Map();
  for (const [ch, n] of letterCounts) out.set(ch, n / total);
  return out;
}

/** Tüm kelime listesi (read-only kullanın). */
export function allWords() {
  ensureLoaded();
  return words;
}

/** Belirli uzunluktaki kelimeler (cache'li — puzzle seed-from-word yolu 6 için kullanır). */
export function wordsOfLength(len) {
  ensureLoaded();
  if (!byLengthCache.has(len)) {
    byLengthCache.set(len, words.filter((w) => w.length === len));
  }
  return byLengthCache.get(len);
}
