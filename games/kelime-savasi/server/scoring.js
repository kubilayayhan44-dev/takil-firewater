// Puanlama + kazanan hesabı (plan Task 6) — SAF fonksiyonlar, IO yok, test dostu.
// Puan tablosu config.SCORING'den gelir (kural: sabit sayılar başka modülde YASAK).

import config from './config.js';

/** Kelime uzunluğuna göre puan: 3→10, 4→25, 5→50, 6→100. Bilinmeyen uzunluk → 0. */
export function wordPoints(word) {
  return config.SCORING.POINTS[String(word).length] ?? 0;
}

/** ≥5 harfli (config.PUZZLE.LONG_WORD_MIN_LEN) kelime sayısı — beraberlik kırılımı #2. */
export function longWordCount(words) {
  return words.filter((w) => w.word.length >= config.PUZZLE.LONG_WORD_MIN_LEN).length;
}

/**
 * Oyuncu listesinden sonuç satırları üretir (game:end payload'ının results[] alanı).
 * UI (ui/results.js) şunu bekler: {id, nickname, score, words: [{word, points}], longWords}
 */
export function buildResults(players) {
  return players.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    score: p.score,
    words: p.words.map((w) => ({ ...w })),
    longWords: longWordCount(p.words),
  }));
}

/**
 * Kazanan zinciri: skor → uzun (≥5 harf) kelime sayısı → toplam kelime → BERABERE.
 * @returns {{winner: string, winnerNickname: string|null}}
 *   winner: kazanan oyuncunun id'si, tam beraberlikte 'tie' (UI sözleşmesi — mock/net.js ile aynı)
 */
export function determineWinner(results) {
  if (results.length !== 2) return { winner: 'tie', winnerNickname: null };
  const [a, b] = results;

  let champ = null;
  if (a.score !== b.score) champ = a.score > b.score ? a : b;
  else if (a.longWords !== b.longWords) champ = a.longWords > b.longWords ? a : b;
  else if (a.words.length !== b.words.length) champ = a.words.length > b.words.length ? a : b;

  if (!champ) return { winner: 'tie', winnerNickname: null };
  return { winner: champ.id, winnerNickname: champ.nickname };
}
