// Puzzle üretici testleri (plan Task 3 kabul kriterleri)
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../server/config.js';
import { loadDictionary, validateWord } from '../server/dictionary.js';
import {
  generate,
  mulberry32,
  getRandomPuzzle,
  evaluateLetters,
  isAcceptable,
  countVowels,
} from '../server/puzzle.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUZZLES_PATH = path.join(ROOT, 'data', 'puzzles.json');

beforeAll(() => {
  loadDictionary();
});

describe('generate() — kabul kriterleri', () => {
  it('her puzzle: 6 harf, 15-80 çözüm, ≥2 uzun kelime, 2-4 sesli harf', () => {
    for (let i = 0; i < 20; i++) {
      const p = generate(mulberry32(1000 + i));
      expect(p.letters, `seed ${1000 + i}`).toHaveLength(config.PUZZLE.LETTER_COUNT);

      expect(p.stats.solutionCount).toBeGreaterThanOrEqual(config.PUZZLE.MIN_SOLUTIONS);
      expect(p.stats.solutionCount).toBeLessThanOrEqual(config.PUZZLE.MAX_SOLUTIONS);
      expect(p.stats.longWords).toBeGreaterThanOrEqual(config.PUZZLE.MIN_LONG_WORDS);

      const vowels = countVowels(p.letters);
      expect(vowels).toBeGreaterThanOrEqual(config.PUZZLE.MIN_VOWELS);
      expect(vowels).toBeLessThanOrEqual(config.PUZZLE.MAX_VOWELS);

      // istatistikler çözümlerle tutarlı
      const re = evaluateLetters(p.letters);
      expect(re.solutions).toEqual(p.solutions);
      expect(re.stats).toEqual(p.stats);
    }
  });

  it('çözümlerin tamamı harf alt-çokluğu ve sözlükte geçerli', () => {
    const p = generate(mulberry32(42));
    const available = new Map();
    for (const ch of p.letters) available.set(ch, (available.get(ch) ?? 0) + 1);
    for (const w of p.solutions) {
      expect(validateWord(w).ok, `sözlükte değil: ${w}`).toBe(true);
      const need = new Map();
      for (const ch of w) need.set(ch, (need.get(ch) ?? 0) + 1);
      for (const [ch, n] of need) {
        expect(n, `${w}: '${ch}' için yetersiz harf`).toBeLessThanOrEqual(available.get(ch) ?? 0);
      }
    }
  });

  it('seeded determinizm: aynı seed → birebir aynı puzzle', () => {
    const a = generate(mulberry32(424242));
    const b = generate(mulberry32(424242));
    expect(b).toEqual(a);

    // farklı seed → (pratikte) farklı puzzle
    const c = generate(mulberry32(777));
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it("seed-from-word yolu: ≥1 altı-harf çözüm GARANTİLİ", () => {
    for (let i = 0; i < 10; i++) {
      const p = generate(mulberry32(7000 + i), { method: 'seed' });
      expect(p.method).toBe('seed');
      expect(p.stats.sixLetterWords).toBeGreaterThanOrEqual(1);
      expect(p.solutions.some((w) => w.length === 6)).toBe(true);
    }
  });

  it('freq yolu da kriterlere uyar (frekans-ağırlıklı 6 harf)', () => {
    for (let i = 0; i < 10; i++) {
      const p = generate(mulberry32(9000 + i), { method: 'freq' });
      expect(p.method).toBe('freq');
      expect(isAcceptable(p.stats)).toBe(true);
      expect(p.letters).toHaveLength(6);
    }
  });
});

describe('getRandomPuzzle — havuz + fallback zinciri', () => {
  it('havuz yoksa canlı üretim fallback çalışır (kriterlere uygun puzzle döner)', () => {
    const p = getRandomPuzzle(path.join(ROOT, 'data', 'yok-boyle-bir-dosya.json'));
    expect(p.letters).toHaveLength(config.PUZZLE.LETTER_COUNT);
    expect(isAcceptable(p.stats)).toBe(true);
  });

  it('bozuk havuz dosyası da canlı üretime düşer', () => {
    const badPath = path.join(ROOT, 'data', 'test-bad-puzzles.json');
    writeFileSync(badPath, '{"bozuk": true}', 'utf8');
    try {
      const p = getRandomPuzzle(badPath);
      expect(p.letters).toHaveLength(6);
      expect(isAcceptable(p.stats)).toBe(true);
    } finally {
      rmSync(badPath, { force: true });
    }
  });

  it('gerçek havuz varsa havuzdan geçerli kayıt döner', () => {
    if (!existsSync(PUZZLES_PATH)) {
      console.warn('(puzzles.json yok — gen-puzzles çalıştırılmamış, atlanıyor)');
      return;
    }
    const pool = JSON.parse(readFileSync(PUZZLES_PATH, 'utf8'));
    const p = getRandomPuzzle(PUZZLES_PATH);
    expect(p.letters).toHaveLength(6);
    expect(Array.isArray(p.solutions)).toBe(true);
    expect(pool.length).toBeGreaterThanOrEqual(config.PUZZLE.POOL_SIZE);
  });
});

describe('puzzle havuzu dosyası — self-consistency (gen-puzzles çıktısı)', () => {
  it.skipIf(!existsSync(PUZZLES_PATH))(
    'havuzdaki her kayıt kriterlere uygun ve letters↔solutions eşleşir',
    () => {
      const pool = JSON.parse(readFileSync(PUZZLES_PATH, 'utf8'));
      expect(pool).toHaveLength(config.PUZZLE.POOL_SIZE);

      const seen = new Set();
      for (const p of pool) {
        expect(p.letters).toHaveLength(config.PUZZLE.LETTER_COUNT);
        expect(isAcceptable(p.stats)).toBe(true);

        const re = evaluateLetters(p.letters);
        expect(re.solutions, `seed ${p.seed} çözümleri tutmuyor`).toEqual(p.solutions);

        const key = [...p.letters].sort().join('');
        expect(seen.has(key), `mükerrer harf seti: ${key}`).toBe(false);
        seen.add(key);
      }
    },
  );
});
