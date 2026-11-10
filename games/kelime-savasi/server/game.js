// Oyun state machine (plan Task 5 + 7): LOBBY → COUNTDOWN(3sn) → PLAYING(90sn) → RESULTS.
//
// Bu modül RoomManager'ın ürettiği oda objeleri üzerinde çalışır; rooms.js bu modülü
// import eder (tek yönlü bağımlılık — döngü yok). Oda objesi sözleşmesi:
//   room.broadcast(event, payload, {exclude}?)   — odadaki TÜM bağlı socket'lere yayın
//   room.publicState()                            — {state, players:[{id,nickname,ready,connected}]}
//   room.touch()                                  — lastActivity güncelle (LOBBY GC ölçümü)
//   room.destroy()                                — odayı yöneticiden sil (tüm timer'lar clear)
//   room.timers.{countdown,end,timeSync,resultsGc} — memory-leak guard: GC'de hepsi clear edilir
//
// Anti-cheat kuralları (plan):
//   - Sözlük/puzzle çözümleri client'a ASLA gönderilmez — çözüm listesi yalnızca game:end'de.
//   - endsAt sunucu-otoriter: süre dolduktan sonraki submit'ler reddedilir.
//   - word:submit akış sırası: rate-limit → normalize → subset → sözlük → duplicate → taken → puan.

import config from './config.js';
import { getRandomPuzzle } from './puzzle.js';
import { validateWord, isReady as dictReady } from './dictionary.js';
import { wordPoints, buildResults, determineWinner } from './scoring.js';
import { turkceLower, isGameWord, turkishCompare } from './turkce.js';

/** Timer temizleyici — hem setTimeout hem clearInterval güvenli şekilde kapatır. */
function clearTimer(room, key) {
  const t = room.timers[key];
  if (t) {
    clearTimeout(t);
    clearInterval(t);
    room.timers[key] = null;
  }
}

/* ============================================================
 * Kelime yardımcıları
 * ============================================================ */

/** Kelime, harf dizisinin alt-çokluğu mu? (multiset subset — kopya harfler doğru sayılır) */
export function isSubsetOfLetters(word, letters) {
  if (!Array.isArray(letters) || letters.length === 0) return false;
  const pool = [...letters];
  for (const ch of word) {
    const i = pool.indexOf(ch);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return true;
}

/**
 * Oyuncu başına token bucket (config.RATE_LIMIT): burst MAX_WORDS kelime,
 * sonrasında pencere boyunca sürekli dolum. Üstü sessizce düşer.
 */
export function allowSubmit(player, now) {
  const { MAX_WORDS: cap, WINDOW_MS: windowMs } = config.RATE_LIMIT;
  if (!player.rate) player.rate = { tokens: cap, last: now };
  const r = player.rate;
  const elapsed = Math.max(0, now - r.last);
  r.tokens = Math.min(cap, r.tokens + (elapsed / windowMs) * cap);
  r.last = now;
  if (r.tokens >= 1) {
    r.tokens -= 1;
    return true;
  }
  return false;
}

/* ============================================================
 * State machine — countdown → start → end
 * ============================================================ */

/** İki oyuncu da hazır mı? Hazırsa geri sayımı başlat (yoksa no-op). */
export function maybeStartCountdown(room) {
  if (room.state !== 'LOBBY' || room.players.size !== 2) return false;
  for (const p of room.players.values()) if (!p.ready) return false;
  startCountdown(room);
  return true;
}

export function startCountdown(room) {
  if (room.state !== 'LOBBY') return;
  clearTimer(room, 'countdown');
  room.state = 'COUNTDOWN';
  room.endsAt = Date.now() + config.COUNTDOWN_MS;
  room.touch();
  room.broadcast('game:countdown', { endsAt: room.endsAt });
  room.timers.countdown = setTimeout(() => startGame(room), config.COUNTDOWN_MS);
}

/** Geri sayımı iptal et ve LOBBY'ye dön (oyuncu ayrıldığında — plan Task 7). */
export function cancelCountdown(room) {
  clearTimer(room, 'countdown');
  if (room.state === 'COUNTDOWN') {
    room.state = 'LOBBY';
    room.endsAt = null;
  }
}

export function startGame(room) {
  if (room.state !== 'COUNTDOWN') return;
  clearTimer(room, 'countdown');

  // Puzzle havuzdan (fallback: canlı üretim). Harfler İKİ oyuncuya da AYNI gider;
  // çözüm listesi (solutions) yalnızca sunucuda kalır — game:end'e kadar client'a gitmez.
  const puzzle = getRandomPuzzle();

  room.state = 'PLAYING';
  room.round += 1;
  room.letters = puzzle.letters.slice();
  room.solutions = puzzle.solutions.slice();
  room.endsAt = Date.now() + config.GAME_DURATION_MS;
  for (const p of room.players.values()) {
    p.score = 0;
    p.words = [];
    p.ready = false;
  }
  room.touch();
  room.broadcast('game:start', {
    letters: room.letters,
    duration: config.GAME_DURATION_MS,
    endsAt: room.endsAt,
  });

  // timeSync — client saati drift düzeltmesi (her TIME_SYNC_INTERVAL_MS)
  clearTimer(room, 'timeSync');
  room.timers.timeSync = setInterval(() => {
    if (room.state === 'PLAYING' && room.endsAt) {
      room.broadcast('game:timeSync', { endsAt: room.endsAt });
    }
  }, config.TIME_SYNC_INTERVAL_MS);

  // Süre bitişi — endsAt otoriter, erken tetiklenmeye karşı drift koruması endGame'de
  clearTimer(room, 'end');
  room.timers.end = setTimeout(() => endGame(room, 'time_up'), config.GAME_DURATION_MS);
}

/**
 * Maçı bitir: timer'ları durdur, sonuçları hesapla, çözüm listesini gönder.
 * Drift koruması: 'time_up' sebebiyle erken çağrıldıysa kalan süreyi yeniden planlar.
 */
export function endGame(room, reason = 'time_up') {
  if (room.state !== 'PLAYING') return;
  if (reason === 'time_up') {
    const remaining = room.endsAt - Date.now();
    if (remaining > 250) {
      clearTimer(room, 'end');
      room.timers.end = setTimeout(() => endGame(room, reason), remaining + 30);
      return;
    }
  }

  clearTimer(room, 'end');
  clearTimer(room, 'timeSync');
  clearTimer(room, 'countdown');
  room.state = 'RESULTS';
  room.resultsAt = Date.now();

  const results = buildResults([...room.players.values()]);
  const { winner, winnerNickname } = determineWinner(results);
  // Tam çözüm listesi (kaçırılanlar dahil) — oyun bitince ilk ve tek kez gönderilir.
  const solutionList = [...(room.solutions ?? [])].sort(
    (a, b) => b.length - a.length || turkishCompare(a, b),
  );

  const payload = { results, winner, winnerNickname, reason, solutionList };
  room.lastEnd = payload; // RESULTS'ta reconnect replay için saklı
  room.touch();
  room.broadcast('game:end', payload);

  // RESULTS oda ömrü — RESULTS_TTL_MS sonra GC (memory-leak guard: destroy tüm timer'ları clear eder)
  clearTimer(room, 'resultsGc');
  room.timers.resultsGc = setTimeout(() => room.destroy(), config.RESULTS_TTL_MS);
}

/* ============================================================
 * word:submit — tam doğrulama zinciri
 * ============================================================ */

/**
 * @returns {{ok:true, word:string, points:number, totalScore:number} |
 *           {ok:false, word?:string, reason:string}}
 * reason'lar UI/mock sözleşmesiyle aynı: not_playing, time_up, rate_limited,
 * too_short, too_long, invalid_chars, not_subset, not_in_dictionary, duplicate,
 * taken (kelime çalma: rakip buldu, oda geneli kilit)
 */
export function submitWord(room, player, raw) {
  if (room.state !== 'PLAYING') return { ok: false, reason: 'not_playing' };

  const now = Date.now();
  if (room.endsAt && now >= room.endsAt) return { ok: false, reason: 'time_up' };
  if (!allowSubmit(player, now)) return { ok: false, reason: 'rate_limited' }; // sessizce düşür

  // Türkçe-aware normalize (İ→i, I→ı, â→a...) — turkce.js ortak modülü
  const word = turkceLower(String(raw ?? '')).trim();

  if (word.length < config.WORD.MIN_LENGTH) return { ok: false, word, reason: 'too_short' };
  if (word.length > config.WORD.MAX_LENGTH) return { ok: false, word, reason: 'too_long' };
  if (!isGameWord(word)) return { ok: false, word, reason: 'invalid_chars' };
  if (!isSubsetOfLetters(word, room.letters)) return { ok: false, word, reason: 'not_subset' };

  if (!dictReady()) return { ok: false, word, reason: 'not_in_dictionary' };
  const v = validateWord(word); // format zaten elendi → burada tek olası red: sözlükte yok
  if (!v.ok) return { ok: false, word, reason: 'not_in_dictionary' };

  if (player.words.some((w) => w.word === word)) return { ok: false, word, reason: 'duplicate' };

  // KELİME ÇALMA (Hediye kararı): kelimeyi İLK gönderen alır — oda geneli kilit.
  // Rakip bu kelimeyi bulduysa ikinci gönderen 'taken' reddi alır: puan yok,
  // state değişikliği yok, broadcast yok (rakip kabulünde word:accepted herkese gitti zaten).
  // Aynı anda gelen iki submit server'ın tek thread'inde sıraya girer → ilk işlenen kazanır.
  for (const other of room.players.values()) {
    if (other === player) continue;
    if (other.words.some((w) => w.word === word)) return { ok: false, word, reason: 'taken' };
  }

  const points = wordPoints(word);
  player.words.push({ word, points });
  player.score += points;
  room.touch();

  // Kabul → ODAYA broadcast (rakip ticker'ı) + submit'e ack.
  // Kelime çalma: aynı kelimeyi rakip SONRADAN gönderemez — yukarıdaki taken kilidi.
  room.broadcast('word:accepted', {
    id: player.id,
    nickname: player.nickname,
    word,
    points,
    score: player.score,
  });

  return { ok: true, word, points, totalScore: player.score };
}

/* ============================================================
 * Rematch — RESULTS → LOBBY (aynı oda, aynı rakip)
 * ============================================================ */

export function rematch(room) {
  if (room.state !== 'RESULTS' && room.state !== 'LOBBY') {
    return { ok: false, error: 'Şu anda tekrar oynanamaz' };
  }
  clearTimer(room, 'resultsGc');
  room.state = 'LOBBY';
  room.letters = null;
  room.solutions = null;
  room.endsAt = null;
  room.lastEnd = null;
  room.resultsAt = null;
  for (const p of room.players.values()) {
    p.ready = false;
    p.score = 0;
    p.words = [];
  }
  room.touch();
  room.broadcast('game:rematch', {});
  room.broadcast('room:state', room.publicState());
  return { ok: true };
}
