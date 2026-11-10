// Puzzle üretimi (plan Task 3):
//   Aday üretimi — iki yol:
//     a) seed-from-word (%60): sözlükten rastgele 6-harf kelime → harfler
//        (≥1 altı-harf çözüm GARANTİLİ)
//     b) frekans-ağırlıklı (%40): kelime listesinden hesaplanan harf frekansı ile
//        6 harf çek, sesli sayısı 2-4 kısıtı
//   Doğrulama — anagram index ile çözüm hesabı + kabul kriterleri (config.PUZZLE)
//   Ret → yeni aday (MAX_ATTEMPTS tavan; aşılırsa throw → havuz fallback devreye girer)
//
// Tüm rastgelelik rng parametresinden akar (seeded determinizm — test reproducibility).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { turkceLower } from './turkce.js';
import {
  loadDictionary,
  isReady,
  solutionsForLetters,
  letterFrequencies,
  wordsOfLength,
} from './dictionary.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUZZLES_PATH = path.join(ROOT, config.PATHS.PUZZLES);

const VOWELS = new Set(['a', 'e', 'ı', 'i', 'o', 'ö', 'u', 'ü']);

/** Deterministik RNG (mulberry32) — aynı seed → aynı puzzle. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Canlı kullanım için seed üretimi. */
export function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

function ensureDict() {
  if (!isReady()) loadDictionary();
}

function randInt(rng, maxExclusive) {
  return Math.floor(rng() * maxExclusive);
}

/** Ağırlıklı rastgele seçim. entries: [harf, ağırlık][] */
function pickWeighted(rng, entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [ch, w] of entries) {
    r -= w;
    if (r <= 0) return ch;
  }
  return entries[entries.length - 1][0];
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function countVowels(letters) {
  return letters.reduce((n, ch) => n + (VOWELS.has(ch) ? 1 : 0), 0);
}

/**
 * Verilen harf seti için çözümleri ve istatistikleri hesaplar.
 * Harf sırası önemsiz (anagram index sorted-key kullanır).
 */
export function evaluateLetters(letters) {
  const norm = letters.map((c) => turkceLower(String(c)));
  const solutions = solutionsForLetters(norm);
  const longWords = solutions.filter((w) => w.length >= config.PUZZLE.LONG_WORD_MIN_LEN).length;
  const sixLetterWords = solutions.filter((w) => w.length === config.PUZZLE.LETTER_COUNT).length;
  return {
    solutions,
    stats: {
      solutionCount: solutions.length,
      longWords,
      sixLetterWords,
      vowels: countVowels(norm),
    },
  };
}

/** Kabul kriterleri (plan Task 3): 15-80 çözüm, ≥2 uzun (≥5 harf) kelime, 2-4 sesli harf. */
export function isAcceptable(stats) {
  const P = config.PUZZLE;
  return (
    stats.solutionCount >= P.MIN_SOLUTIONS &&
    stats.solutionCount <= P.MAX_SOLUTIONS &&
    stats.longWords >= P.MIN_LONG_WORDS &&
    stats.vowels >= P.MIN_VOWELS &&
    stats.vowels <= P.MAX_VOWELS
  );
}

/** Tek aday harf seti üretir (kabul kontrolü generate içinde). */
function makeCandidate(rng, method) {
  const P = config.PUZZLE;

  if (method === 'seed') {
    const six = wordsOfLength(P.LETTER_COUNT);
    const word = six[randInt(rng, six.length)];
    return { letters: shuffle(word.split(''), rng), method };
  }

  // 'freq' — frekans-ağırlıklı örnekleme, sesli hedefi 2..4 arası
  const freq = letterFrequencies();
  const weightedVowels = [...freq.entries()].filter(([ch]) => VOWELS.has(ch));
  const weightedConsonants = [...freq.entries()].filter(([ch]) => !VOWELS.has(ch));
  const vowelTarget = P.MIN_VOWELS + randInt(rng, P.MAX_VOWELS - P.MIN_VOWELS + 1);
  const letters = [];
  for (let i = 0; i < vowelTarget; i++) letters.push(pickWeighted(rng, weightedVowels));
  while (letters.length < P.LETTER_COUNT) letters.push(pickWeighted(rng, weightedConsonants));
  return { letters: shuffle(letters, rng), method };
}

/**
 * Ana üretim fonksiyonu — kabul edilen puzzle döndürür.
 * @param {() => number} rng seeded RNG (default: canlı seed'li mulberry32)
 * @param {{method?: 'seed'|'freq', onReject?: Function}} opts
 *   method   — yol zorlama (test determinizmi)
 *   onReject — ret edilen aday için gözlem callback'i (gen-puzzles ret oranı metriği)
 * @returns {{letters: string[], solutions: string[], stats: object, method: string}}
 * @throws 60 denemede kriterler sağlanamazsa (havuz fallback devreye girer)
 */
export function generate(rng = mulberry32(randomSeed()), opts = {}) {
  ensureDict();
  const P = config.PUZZLE;
  for (let attempt = 1; attempt <= P.MAX_ATTEMPTS; attempt++) {
    const method = opts.method ?? (rng() < 0.6 ? 'seed' : 'freq');
    const candidate = makeCandidate(rng, method);
    const { solutions, stats } = evaluateLetters(candidate.letters);
    if (isAcceptable(stats)) {
      return { letters: candidate.letters, solutions, stats, method: candidate.method };
    }
    if (typeof opts.onReject === 'function') opts.onReject(candidate.letters, stats);
  }
  throw new Error(`Puzzle üretilemedi: ${P.MAX_ATTEMPTS} denemede kriterler sağlanmadı`);
}

// --- Havuz (data/puzzles.json — gen-puzzles.mjs offline üretir) ---

const poolCache = new Map(); // filePath → pool | null

function loadPool(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('puzzle havuzu boş veya geçersiz');
  }
  for (const p of raw) {
    if (
      !Array.isArray(p.letters) || p.letters.length !== config.PUZZLE.LETTER_COUNT ||
      !Array.isArray(p.solutions) || p.solutions.length === 0
    ) {
      throw new Error('puzzle havuzunda bozuk kayıt var');
    }
  }
  return raw;
}

/**
 * Maç için rastgele puzzle: önce offline havuz (data/puzzles.json), havuz yoksa ya
 * da bozuksa canlı generate() fallback (plan Task 3 fallback zinciri).
 * @param {string} [filePath] test edilebilirlik için path override
 */
export function getRandomPuzzle(filePath = PUZZLES_PATH) {
  if (!poolCache.has(filePath)) {
    let pool = null;
    try {
      pool = existsSync(filePath) ? loadPool(filePath) : null;
      if (pool === null) console.warn('[puzzle] havuz yok — canlı üretim fallback');
    } catch (err) {
      console.warn('[puzzle] havuz yüklenemedi — canlı üretim fallback:', err.message);
    }
    poolCache.set(filePath, pool);
  }
  const pool = poolCache.get(filePath);
  if (pool) return pool[randInt(Math.random, pool.length)];
  return generate(); // fallback — canlı üretim
}
