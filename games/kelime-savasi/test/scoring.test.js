// Scoring testleri (plan Task 6 kabul kriterleri):
// puan tablosu, 3 beraberlik kırılımı senaryosu, kazanan ilanı.
import { describe, it, expect } from 'vitest';
import config from '../server/config.js';
import { wordPoints, longWordCount, buildResults, determineWinner } from '../server/scoring.js';

/** Test oyuncusu üretici — buildResults/determineWinner saf veri ile çalışır. */
function player(id, nickname, words) {
  const entries = words.map((word) => ({ word, points: wordPoints(word) }));
  return {
    id,
    nickname,
    score: entries.reduce((s, w) => s + w.points, 0),
    words: entries,
    longWords: longWordCount(entries),
  };
}

describe('wordPoints — puan tablosu', () => {
  it('3→10, 4→25, 5→50, 6→100 (config.SCORING ile tutarlı)', () => {
    expect(wordPoints('ata')).toBe(config.SCORING.POINTS[3]);
    expect(wordPoints('elma')).toBe(config.SCORING.POINTS[4]);
    expect(wordPoints('kalem')).toBe(config.SCORING.POINTS[5]);
    expect(wordPoints('kelime')).toBe(config.SCORING.POINTS[6]);
    expect(config.SCORING.POINTS).toEqual({ 3: 10, 4: 25, 5: 50, 6: 100 });
  });

  it('plan değerleri sabit: 10 / 25 / 50 / 100', () => {
    expect(wordPoints('kan')).toBe(10);
    expect(wordPoints('kale')).toBe(25);
    expect(wordPoints('kelam')).toBe(50);
    expect(wordPoints('kelime')).toBe(100);
  });

  it('oyun dışı uzunluklar → 0 puan (2, 7, boş)', () => {
    expect(wordPoints('ab')).toBe(0);
    expect(wordPoints('yediharfl')).toBe(0);
    expect(wordPoints('')).toBe(0);
  });
});

describe('longWordCount — ≥5 harfli kelime sayısı', () => {
  it('sadece uzun kelimeler sayılır', () => {
    const words = [
      { word: 'ata', points: 10 },
      { word: 'elma', points: 25 },
      { word: 'kalem', points: 50 },
      { word: 'kelime', points: 100 },
    ];
    expect(longWordCount(words)).toBe(2);
  });

  it('uzun kelime yoksa 0', () => {
    expect(longWordCount([{ word: 'ata', points: 10 }])).toBe(0);
    expect(longWordCount([])).toBe(0);
  });
});

describe('buildResults — game:end results[] şekli', () => {
  it('UI sözleşmesi: {id, nickname, score, words:[{word,points}], longWords}', () => {
    const [r] = buildResults([player('p1', 'Ayşe', ['ata', 'kalem'])]);
    expect(r).toMatchObject({
      id: 'p1',
      nickname: 'Ayşe',
      score: 10 + 50,
      longWords: 1,
    });
    expect(r.words).toEqual([
      { word: 'ata', points: 10 },
      { word: 'kalem', points: 50 },
    ]);
  });

  it("kaynak words dizisi kopyalanır (sonradan mutasyon results'ı etkilemez)", () => {
    const p = player('p1', 'Ayşe', ['ata']);
    const [r] = buildResults([p]);
    p.words.push({ word: 'elma', points: 25 });
    expect(r.words).toHaveLength(1);
  });
});

describe('determineWinner — zincir: skor → uzun kelime → toplam kelime → beraberlik', () => {
  it('1) skor farkı: yüksek skor kazanır', () => {
    const a = player('a', 'Ayşe', ['kalem', 'ata']); // 60
    const b = player('b', 'Mehmet', ['elma', 'ata']); // 35
    expect(a.score).toBe(60);
    expect(b.score).toBe(35);
    const res = determineWinner([a, b]);
    expect(res).toEqual({ winner: 'a', winnerNickname: 'Ayşe' });
  });

  it('kırılım 2 — skor eşit, uzun (≥5 harf) kelime sayısı belirler', () => {
    const a = player('a', 'Ayşe', ['elma', 'kale', 'ata']); // 25+25+10 = 60, uzun 0
    const b = player('b', 'Mehmet', ['kalem', 'ata']); // 50+10 = 60, uzun 1
    expect(a.score).toBe(b.score);
    const res = determineWinner([a, b]);
    expect(res).toEqual({ winner: 'b', winnerNickname: 'Mehmet' });
  });

  it('kırılım 3 — skor + uzun kelime eşit, TOPLAM kelime sayısı belirler', () => {
    // 50 puan, uzun (≥5) kelime 0 — iki farklı yol:
    const a = player('a', 'Ayşe', ['ata', 'kan', 'kaz', 'kol', 'kus']); // 5×10 = 50, 5 kelime
    const b = player('b', 'Mehmet', ['elma', 'kale']); // 25+25 = 50, 2 kelime
    expect(a.score).toBe(50);
    expect(b.score).toBe(50);
    expect(longWordCount(a.words)).toBe(0);
    expect(longWordCount(b.words)).toBe(0);
    const res = determineWinner([a, b]);
    expect(res).toEqual({ winner: 'a', winnerNickname: 'Ayşe' }); // daha çok kelime
  });

  it('kırılım 4 — hepsi eşitse BERABERE (winner: "tie", winnerNickname: null)', () => {
    const a = player('a', 'Ayşe', ['elma', 'ata']); // 35, uzun 0, 2 kelime
    const b = player('b', 'Mehmet', ['kale', 'kan']); // 35, uzun 0, 2 kelime
    expect(a.score).toBe(b.score);
    const res = determineWinner([a, b]);
    expect(res).toEqual({ winner: 'tie', winnerNickname: null });
  });

  it('uçtan uca: buildResults → determineWinner (aynı skor farklı uzun kelime)', () => {
    const a = buildResults([player('a', 'Ayşe', ['kelime', 'ata'])])[0]; // 110, uzun 1
    const b = buildResults([player('b', 'Mehmet', ['kalem', 'elma', 'ata'])])[0]; // 85
    expect(determineWinner([a, b]).winner).toBe('a');
  });

  it('tek oyuncu (1 kişi) → tie (kazanan ilanı iki kişi ister)', () => {
    expect(determineWinner([player('a', 'Ayşe', ['elma'])])).toEqual({
      winner: 'tie',
      winnerNickname: null,
    });
  });
});
