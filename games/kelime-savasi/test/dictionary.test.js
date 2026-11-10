// Sözlük modülü testleri (plan Task 2 kabul kriterleri)
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDictionary, validateWord, solutionsForLetters, allWords, isReady } from '../server/dictionary.js';
import { turkceLower, isGameWord, turkishCompare } from '../server/turkce.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORDS_PATH = path.join(ROOT, 'data', 'words.tr.json');

beforeAll(() => {
  const { count } = loadDictionary(WORDS_PATH);
  expect(count).toBeGreaterThan(0);
});

describe('turkceLower — Türkçe-aware normalizasyon', () => {
  it("'IŞIK' → 'ışık' (I→ı noktasız, Ş→ş)", () => {
    expect(turkceLower('IŞIK')).toBe('ışık');
  });

  it("'İple' → 'iple' (İ→i noktalı)", () => {
    expect(turkceLower('İple')).toBe('iple');
  });

  it('uzun üye strip: â→a, î→i, û→u (büyükleriyle)', () => {
    expect(turkceLower('kâbus')).toBe('kabus');
    expect(turkceLower('KÂBUS')).toBe('kabus');
    expect(turkceLower('î')).toBe('i');
    expect(turkceLower('Î')).toBe('i');
    expect(turkceLower('û')).toBe('u');
    expect(turkceLower('Û')).toBe('u');
  });

  it('ASCII ve diğer karakterlere dokunmaz', () => {
    expect(turkceLower('')).toBe('');
    expect(turkceLower('abcXYZ')).toBe('abcxyz');
    expect(turkceLower('çğıöşü')).toBe('çğıöşü');
  });
});

describe('validateWord', () => {
  it("'IŞIK' → normalize edilmiş 'ışık' geçerli", () => {
    const r = validateWord('IŞIK');
    expect(r.ok).toBe(true);
    expect(r.word).toBe('ışık');
  });

  it("'isik' (noktasız i ile) geçersiz — 'ışık' ayrı kelime", () => {
    const r = validateWord('isik');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_in_dictionary');
  });

  it("'İple' → 'iple' normalize edilir (I/İ karışmaz)", () => {
    const r = validateWord('İple');
    expect(r.word).toBe('iple');
    // 'iple' listede stem olarak varsa ok; olmasaydı reason: not_in_dictionary olurdu —
    // kritik olan normalizasyonun İ→i yapması (ıple OLMAMALI)
    if (r.ok) expect(r.word).toBe('iple');
  });

  it('format dışı girişler red: 2 harf, 7 harf, boş, işaretli, rakamlı', () => {
    expect(validateWord('ab').reason).toBe('format');
    expect(validateWord('yediharfli').reason).toBe('format');
    expect(validateWord('ab-cd').reason).toBe('format');
    expect(validateWord('abc1').reason).toBe('format');
    expect(validateWord('').reason).toBe('invalid');
    expect(validateWord(null).reason).toBe('invalid');
    expect(validateWord(undefined).reason).toBe('invalid');
    expect(validateWord(12345).reason).toBe('invalid');
  });

  it('biçim olarak geçerli ama sözlükte olmayan kelime: not_in_dictionary', () => {
    expect(validateWord('zqxvbn').reason).toBe('not_in_dictionary');
  });
});

describe('kelime listesi kalitesi (data/words.tr.json)', () => {
  let words;
  beforeAll(() => {
    words = allWords();
  });

  it('liste mevcut ve yüklü', () => {
    expect(isReady()).toBe(true);
    expect(words.length).toBeGreaterThan(0);
  });

  it('kalite guard: ≥ 25000 kelime', () => {
    expect(words.length).toBeGreaterThanOrEqual(25_000);
  });

  it("her kelime 3-6 harf ve yalnız [a-zçğıöşü]", () => {
    for (const w of words) {
      expect(isGameWord(w), `bozuk kelime: ${w}`).toBe(true);
    }
  });

  it("uzun üye (â/î/û) ve büyük harf YOK", () => {
    for (const w of words) {
      expect(/[âîûÂÎÛ]/.test(w), `circumflex kaldı: ${w}`).toBe(false);
      expect(/[A-ZÇĞİÖŞÜ]/.test(w), `büyük harf kaldı: ${w}`).toBe(false);
    }
  });

  it("öbek kontrol: 'elma' listede, 'Ahmet' (özel isim) listede değil", () => {
    expect(words).toContain('elma');
    expect(words).not.toContain('ahmet');
  });

  it('liste Türk alfabesine göre sıralı ve unique', () => {
    for (let i = 1; i < words.length; i++) {
      if (words[i] === words[i - 1]) {
        expect.unreachable(`mükerrer kelime: ${words[i]}`);
      }
      if (turkishCompare(words[i - 1], words[i]) > 0) {
        expect.unreachable(`sıra bozuk: '${words[i - 1]}' > '${words[i]}'`);
      }
    }
  });
});

describe('anagram index — solutionsForLetters', () => {
  it("['e','l','m','a'] → 'elma' (ve 'amel') içerir", () => {
    const sols = solutionsForLetters(['e', 'l', 'm', 'a']);
    expect(sols).toContain('elma');
    expect(sols).toContain('amel');
  });

  it('dönen her kelime verilen harflerin alt-çokluğudur ve sözlükte geçerlidir', () => {
    const letters = ['e', 'l', 'm', 'a'];
    const available = new Map([['e', 1], ['l', 1], ['m', 1], ['a', 1]]);
    for (const w of solutionsForLetters(letters)) {
      expect(validateWord(w).ok, `sözlükte değil: ${w}`).toBe(true);
      const need = new Map();
      for (const ch of w) need.set(ch, (need.get(ch) ?? 0) + 1);
      for (const [ch, n] of need) {
        expect(n, `${w}: '${ch}' için yetersiz harf`).toBeLessThanOrEqual(available.get(ch) ?? 0);
      }
    }
  });

  it('kopya harf çokluğu doğru işlenir (multiset): "anne"/"nane"; tek a ile "ala" çıkmaz', () => {
    // ['a','n','n','e'] → çift n kullanan kelimeler bulunur
    const sols = solutionsForLetters(['a', 'n', 'n', 'e']);
    expect(sols).toContain('anne');
    expect(sols).toContain('nane');

    // ['a','l','ı'] tek 'a' içerir → 'ala' (a-l-a, İKİ a) DÖNMEMELİ, 'alı' döner
    const tek = solutionsForLetters(['a', 'l', 'ı']);
    expect(tek).toContain('alı');
    expect(tek).not.toContain('ala');
  });

  it('2 harf → boş (minimum 3), boş dizi → boş', () => {
    expect(solutionsForLetters(['a', 'b'])).toEqual([]);
    expect(solutionsForLetters([])).toEqual([]);
  });
});
