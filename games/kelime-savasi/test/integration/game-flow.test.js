// Entegrasyon testi (plan Task 5/6/7 kabul kriterleri): gerçek socket.io-client ile
// 2 sahte oyuncu full akış — create→join→ready→countdown→start→submit→end + resilience.
//
// Süreler config üzerinden KISALTILIR (COUNTDOWN 400ms, GAME 2500ms, timeSync 350ms);
// rate-limit testi ayrı odada küçük limit override ile koşar, sonra restore edilir.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import config from '../../server/config.js';
import { createApp } from '../../server/index.js';
import { solutionsForLetters, allWords, validateWord } from '../../server/dictionary.js';
import { wordPoints, determineWinner } from '../../server/scoring.js';
import { turkishCompare } from '../../server/turkce.js';

// --- Orijinal config değerleri — afterAll'da restore ---
const ORIG = {
  COUNTDOWN_MS: config.COUNTDOWN_MS,
  GAME_DURATION_MS: config.GAME_DURATION_MS,
  TIME_SYNC_INTERVAL_MS: config.TIME_SYNC_INTERVAL_MS,
  RATE_LIMIT: { ...config.RATE_LIMIT },
};

let server;
let manager;
let URL;
const clients = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const c = io(URL, {
    path: `${config.BASE_PATH}/socket.io`,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  clients.push(c);
  return c;
}

function emitAck(c, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 8_000);
    c.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

function once(c, event, { filter, timeout = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    const on = (payload) => {
      if (filter && !filter(payload)) return;
      c.off(event, on);
      clearTimeout(t);
      resolve(payload);
    };
    const t = setTimeout(() => {
      c.off(event, on);
      reject(new Error(`event timeout: ${event}`));
    }, timeout);
    c.on(event, on);
  });
}

/** letters multiset'iyle kelime uyum testi (server isSubsetOfLetters aynası). */
function isSubset(word, letters) {
  const pool = [...letters];
  for (const ch of word) {
    const i = pool.indexOf(ch);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return true;
}

/** Harflerden türetilmiş ama sözlükte OLMAYAN bir sahte kelime bul. */
function findNonWord(letters) {
  const tries = [];
  for (let i = 0; i + 2 < letters.length; i++) {
    tries.push(letters[i] + letters[i + 1] + letters[i + 2]);
    tries.push(letters[i + 2] + letters[i] + letters[i + 1]);
    tries.push(letters[i + 1] + letters[i + 2] + letters[i]);
  }
  return tries.find((w) => !validateWord(w).ok);
}

beforeAll(async () => {
  config.COUNTDOWN_MS = 400;
  config.GAME_DURATION_MS = 2_500;
  config.TIME_SYNC_INTERVAL_MS = 350;

  const app = createApp();
  server = app.server;
  manager = app.manager;
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  URL = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  Object.assign(config, {
    COUNTDOWN_MS: ORIG.COUNTDOWN_MS,
    GAME_DURATION_MS: ORIG.GAME_DURATION_MS,
    TIME_SYNC_INTERVAL_MS: ORIG.TIME_SYNC_INTERVAL_MS,
  });
  config.RATE_LIMIT = { ...ORIG.RATE_LIMIT };

  for (const c of clients) {
    try { c.disconnect(); } catch { /* yoksay */ }
  }
  manager.close();
  await new Promise((res) => server.close(res));
});

describe('tam oyun akışı — 2 sahte oyuncu', () => {
  it('create → join → ready → countdown → game:start (harfler İKİSİNE AYNI)', async () => {
    const p1 = connect();
    const p2 = connect();
    await Promise.all([once(p1, 'connect'), once(p2, 'connect')]);

    // Oda kur
    const r1 = await emitAck(p1, 'room:create', { nickname: 'Ayşe' });
    expect(r1.ok).toBe(true);
    expect(r1.roomCode).toMatch(/^[A-Z]{4}$/);
    expect(r1.playerToken).toBeTruthy();

    // Katıl — host'a playerJoined gider
    const joinPromise = once(p1, 'room:playerJoined');
    const r2 = await emitAck(p2, 'room:join', { roomCode: r1.roomCode, nickname: 'Mehmet' });
    expect(r2.ok).toBe(true);
    expect(r2.host).toEqual({ nickname: 'Ayşe' });
    expect((await joinPromise).nickname).toBe('Mehmet');

    // Hazır — dinleyicileri EMİT'TEN ÖNCE tak (server ack'den önce yayınlar)
    const cd1 = once(p1, 'game:countdown');
    const cd2 = once(p2, 'game:countdown');
    const st1 = once(p1, 'game:start');
    const st2 = once(p2, 'game:start');
    expect((await emitAck(p1, 'game:ready', { ready: true })).ok).toBe(true);
    expect((await emitAck(p2, 'game:ready', { ready: true })).ok).toBe(true);

    const [c1, c2] = await Promise.all([cd1, cd2]);
    expect(c1.endsAt).toBeGreaterThan(Date.now());
    expect(c1.endsAt).toBe(c2.endsAt);

    const [s1, s2] = await Promise.all([st1, st2]);
    expect(s1.letters).toEqual(s2.letters); // harfler İKİSİNE AYNI
    expect(s1.endsAt).toBe(s2.endsAt);
    expect(s1.duration).toBe(config.GAME_DURATION_MS);
    expect(s1.letters).toHaveLength(config.PUZZLE.LETTER_COUNT);

    // --- kelime akışı ---
    const letters = s1.letters;
    const solutions = solutionsForLetters(letters);
    expect(solutions.length).toBeGreaterThanOrEqual(config.PUZZLE.MIN_SOLUTIONS);

    const w3 = solutions.find((w) => w.length === 3);
    const w4 = solutions.find((w) => w.length === 4);
    expect(w3).toBeTruthy();
    expect(w4).toBeTruthy();

    // 1) geçerli kelime → kabul + ODAYA broadcast (ikisi de görür)
    const accP1a = once(p1, 'word:accepted');
    const accP2a = once(p2, 'word:accepted');
    const a1 = await emitAck(p1, 'word:submit', { word: w3 });
    expect(a1).toMatchObject({ ok: true, word: w3, points: wordPoints(w3), totalScore: wordPoints(w3) });
    const [bSelf, bFoe] = await Promise.all([accP1a, accP2a]);
    expect(bSelf).toMatchObject({ nickname: 'Ayşe', word: w3, points: wordPoints(w3), score: wordPoints(w3) });
    expect(bFoe).toEqual(bSelf);
    expect(bSelf.id).toBe(r1.playerId);

    // 2) geçersiz kelime → red, reason'lu
    const nonWord = findNonWord(letters);
    expect(nonWord, 'harflerden türetilmiş sahte kelime bulunamadı').toBeTruthy();
    const bad = await emitAck(p1, 'word:submit', { word: nonWord });
    expect(bad).toMatchObject({ ok: false, word: nonWord, reason: 'not_in_dictionary' });

    // 3) harf dışı kelime (sözlükte var ama bu harflerle kurulamaz) → not_subset
    const notSubset = allWords().find((w) => !isSubset(w, letters));
    expect(notSubset).toBeTruthy();
    const sub = await emitAck(p1, 'word:submit', { word: notSubset });
    expect(sub.reason).toBe('not_subset');

    // 4) kısa kelime → too_short
    expect((await emitAck(p1, 'word:submit', { word: 'ab' })).reason).toBe('too_short');

    // 5) duplicate → 0 puan, reason: duplicate
    const dup = await emitAck(p1, 'word:submit', { word: w3 });
    expect(dup).toMatchObject({ ok: false, word: w3, reason: 'duplicate' });

    // 6) KELİME ÇALMA: rakip aynı kelimeyi gönderemez → taken, puan yok
    const a2 = await emitAck(p2, 'word:submit', { word: w3 });
    expect(a2).toMatchObject({ ok: false, word: w3, reason: 'taken' });
    expect(a2.totalScore).toBeUndefined(); // taken hiçbir puan taşımaz

    // 7) 4 harfli ikinci kelime — skor birikimi
    const a3 = await emitAck(p1, 'word:submit', { word: w4 });
    expect(a3).toMatchObject({
      ok: true,
      word: w4,
      points: wordPoints(w4),
      totalScore: wordPoints(w3) + wordPoints(w4),
    });

    // 8) timeSync geliyor (drift düzeltme)
    const ts = await once(p1, 'game:timeSync', { timeout: 4_000 });
    expect(ts.endsAt).toBe(s1.endsAt);

    // 9-10) bitiş dinleyicilerini SÜRE DOLMAKTAN ÖNCE tak (event kaçmasın)
    const end1 = once(p1, 'game:end', { timeout: 8_000 });
    const end2 = once(p2, 'game:end', { timeout: 8_000 });

    // süre bitti → geç submit red (time_up ya da not_playing — ikisi de "bitmiş" kanıtı)
    await sleep(Math.max(0, s1.endsAt - Date.now()) + 500);
    const late = await emitAck(p1, 'word:submit', { word: w4 });
    expect(late.ok).toBe(false);
    expect(['time_up', 'not_playing']).toContain(late.reason);

    // game:end — winner + TAM çözüm listesi
    const [endP1, endP2] = await Promise.all([end1, end2]);
    for (const end of [endP1, endP2]) {
      expect(end.reason).toBe('time_up');
      expect(end.solutionList).toEqual(
        [...solutions].sort((a, b) => b.length - a.length || turkishCompare(a, b)),
      );
      // anti-cheat: çözüm listesinde oyun sırasında GÖNDERİLMEMİŞTİ — şimdi ilk kez geldi
      expect(end.solutionList.length).toBeGreaterThanOrEqual(config.PUZZLE.MIN_SOLUTIONS);
    }

    // skorlar: p1 = w3+w4, p2 = boş (taken reddi puan getirmedi, state değişmedi)
    const res1 = endP1.results.find((r) => r.id === r1.playerId);
    const res2 = endP1.results.find((r) => r.id === r2.playerId);
    expect(res1.words.map((w) => w.word).sort()).toEqual([w3, w4].sort());
    expect(res2.words.map((w) => w.word)).toEqual([]);
    expect(res1.score).toBe(wordPoints(w3) + wordPoints(w4));
    expect(res2.score).toBe(0);

    // kazanan ilanı server payload'ı ile scoring determinizmi tutarlı
    expect(endP1.winner).toBe(determineWinner(endP1.results).winner);
    expect(endP1.winnerNickname).toBe(
      endP1.winner === 'tie' ? null : endP1.results.find((r) => r.id === endP1.winner).nickname,
    );

    // 11) bitişten sonra submit → not_playing
    expect((await emitAck(p1, 'word:submit', { word: w4 })).reason).toBe('not_playing');

    // 12) rematch → her ikisi de lobiye döner (UI playAgain sözleşmesi)
    const rem1 = once(p1, 'game:rematch');
    const rem2 = once(p2, 'game:rematch');
    const lobbyBack = once(p1, 'room:state', { filter: (st) => st.state === 'LOBBY' });
    expect((await emitAck(p1, 'game:rematch', {})).ok).toBe(true);
    await Promise.all([rem1, rem2, lobbyBack]);
  });

  it('kelime çalma (çift yönlü): p2 ÖNCE bulur → p1 aynı kelimeyi taken alır, puan alamaz', async () => {
    const p1 = connect();
    const p2 = connect();
    await Promise.all([once(p1, 'connect'), once(p2, 'connect')]);

    const r1 = await emitAck(p1, 'room:create', { nickname: 'Elif' });
    const r2 = await emitAck(p2, 'room:join', { roomCode: r1.roomCode, nickname: 'Burak' });

    const st1 = once(p1, 'game:start');
    const st2 = once(p2, 'game:start');
    await emitAck(p1, 'game:ready', { ready: true });
    await emitAck(p2, 'game:ready', { ready: true });
    const [s1] = await Promise.all([st1, st2]);

    const solutions = solutionsForLetters(s1.letters);
    const w = solutions.find((x) => x.length === 3);
    expect(w).toBeTruthy();

    // p2 ÖNCE bulur → kabul + puan
    const acc = await emitAck(p2, 'word:submit', { word: w });
    expect(acc).toMatchObject({ ok: true, word: w, points: wordPoints(w), totalScore: wordPoints(w) });

    // taken reddi BROADCAST ETMEMELİ — dinleyiciyi göndermeden önce tak
    const acceptedLog = [];
    p2.on('word:accepted', (payload) => acceptedLog.push(payload));

    // p1 aynı kelimeyi gönderir → taken: puan yok, totalScore yok
    const taken = await emitAck(p1, 'word:submit', { word: w });
    expect(taken).toMatchObject({ ok: false, word: w, reason: 'taken' });
    expect(taken.totalScore).toBeUndefined();

    await sleep(300); // broadcast olsaydı şimdiye düşerdi
    expect(acceptedLog).toHaveLength(0); // taken kelime ticker'a/odaya gitmez

    // state değişmedi kanıtı: maç sonunda p1'in listesi boş, skoru 0; p2 puanı yerinde
    const endP1 = await once(p1, 'game:end', { timeout: 8_000 });
    const res1 = endP1.results.find((r) => r.id === r1.playerId);
    const res2 = endP1.results.find((r) => r.id === r2.playerId);
    expect(res1.words).toEqual([]);
    expect(res1.score).toBe(0);
    expect(res2.score).toBe(wordPoints(w));
  });
});

describe('rate-limit — token bucket (config override)', () => {
  it('5 hızlı submit: ilk 3 kabul, sonrası rate_limited ile düşer', async () => {
    config.RATE_LIMIT.MAX_WORDS = 3;
    config.RATE_LIMIT.WINDOW_MS = 60_000; // test süresince dolum ihmal edilebilir

    const p1 = connect();
    const p2 = connect();
    await Promise.all([once(p1, 'connect'), once(p2, 'connect')]);
    const r1 = await emitAck(p1, 'room:create', { nickname: 'Hızlı' });
    await emitAck(p2, 'room:join', { roomCode: r1.roomCode, nickname: 'Sakin' });

    const st1 = once(p1, 'game:start');
    const st2 = once(p2, 'game:start');
    await emitAck(p1, 'game:ready', { ready: true });
    await emitAck(p2, 'game:ready', { ready: true });
    const [s1, s2] = await Promise.all([st1, st2]);

    const words = solutionsForLetters(s1.letters).slice(0, 5);
    expect(words.length).toBe(5);
    expect(s2.letters).toEqual(s1.letters);

    const acks = [];
    for (const w of words) acks.push(await emitAck(p1, 'word:submit', { word: w }));

    expect(acks.slice(0, 3).every((a) => a.ok)).toBe(true); // burst 3
    expect(acks[3]).toMatchObject({ ok: false, reason: 'rate_limited' }); // sessizce düştü
    expect(acks[4]).toMatchObject({ ok: false, reason: 'rate_limited' });

    // oyun yine normal biter
    const end = await once(p1, 'game:end', { timeout: 6_000 });
    expect(end.reason).toBe('time_up');
    expect(end.results.find((r) => r.id === r1.playerId).score).toBe(
      wordPoints(words[0]) + wordPoints(words[1]) + wordPoints(words[2]),
    );

    config.RATE_LIMIT = { ...ORIG.RATE_LIMIT }; // sonraki describe'lar temiz limite dönsün
  });
});

describe('dayanıklılık — PLAYING disconnect → reconnect → replay', () => {
  it('disconnect: oyun DURMAZ, reconnect: skor/kelime/timer korunur, maç biter', async () => {
    // beforeAll'daki 2.5sn'lik süre test ortamında (await zinciri + RTT şişmesi)
    // disconnect'a kadar dolabiliyordu → PLAYING yerine RESULTS görünüp filter kaçıyor.
    // Bu test için süreyi uzat: disconnect + reconnect + replay rahat sığsın.
    const origDur = config.GAME_DURATION_MS;
    config.GAME_DURATION_MS = 8_000;

    try {
    const p5 = connect();
    const p6 = connect();
    await Promise.all([once(p5, 'connect'), once(p6, 'connect')]);

    const r5 = await emitAck(p5, 'room:create', { nickname: 'Kemal' });
    const r6 = await emitAck(p6, 'room:join', { roomCode: r5.roomCode, nickname: 'Zeynep' });

    const st5 = once(p5, 'game:start');
    const st6 = once(p6, 'game:start');
    await emitAck(p5, 'game:ready', { ready: true });
    await emitAck(p6, 'game:ready', { ready: true });
    const [s5, s6] = await Promise.all([st5, st6]);
    expect(s5.letters).toEqual(s6.letters);

    // misafir bağlantı kopmadan önce bir kelime bulur
    const w = solutionsForLetters(s5.letters).find((x) => x.length === 4);
    const got = await emitAck(p6, 'word:submit', { word: w });
    expect(got.ok).toBe(true);
    expect(got.totalScore).toBe(wordPoints(w));

    // KOPTU — oyun durmamalı, host connected:false görür
    const sawDown = once(p5, 'room:state', {
      filter: (st) => st.state === 'PLAYING' &&
        st.players.find((p) => p.id === r6.playerId)?.connected === false,
    });
    p6.disconnect();
    const downState = await sawDown;
    expect(downState.players.find((p) => p.id === r6.playerId).connected).toBe(false);

    // YENİ BAĞLANTI + token → tam replay
    // ⚠️ Dinleyiciyi EMİT'TEN ÖNCE tak: reconnectByToken broadcast'i ack'den
    // önce gider — sonra takılan listener event'i kaçırır (yarış koşulu)
    const backUp = once(p5, 'room:state', {
      filter: (st) => st.players.find((p) => p.id === r6.playerId)?.connected === true,
    });
    const p6b = connect();
    await once(p6b, 'connect');
    const replay = await emitAck(p6b, 'room:reconnect', { playerToken: r6.playerToken });
    expect(replay.ok).toBe(true);
    expect(replay.state).toBe('PLAYING');
    expect(replay.letters).toEqual(s5.letters);
    expect(replay.endsAt).toBe(s5.endsAt);
    expect(replay.you.id).toBe(r6.playerId);
    expect(replay.you.score).toBe(wordPoints(w));
    expect(replay.you.words).toEqual([{ word: w, points: wordPoints(w) }]);
    expect(replay.opponent).toMatchObject({ nickname: 'Kemal', connected: true });
    expect(replay.roomState.players.find((p) => p.id === r6.playerId).connected).toBe(true);

    // host geri dönüşü görür (listener emit'ten önce takıldı — bkz. backUp)
    await backUp;

    // maç disconnect'e rağmen normal biter — ikisi de game:end alır
    const [e5, e6] = await Promise.all([
      once(p5, 'game:end', { timeout: 8_000 }),
      once(p6b, 'game:end', { timeout: 8_000 }),
    ]);
    expect(e5.reason).toBe('time_up');
    expect(e6.reason).toBe('time_up');
    expect(e5.winner).toBe(e6.winner);
    } finally {
      config.GAME_DURATION_MS = origDur;
    }
  });
});

describe('dayanıklılık — COUNTDOWN\'da ayrılma → LOBBY\'ye dönüş', () => {
  it('geri sayımda disconnect: playerLeft + LOBBY, oyun BAŞLAMAZ', async () => {
    const origCountdown = config.COUNTDOWN_MS;
    config.COUNTDOWN_MS = 2_000; // disconnect'e zaman kalması için uzat

    try {
      const p7 = connect();
      const p8 = connect();
      await Promise.all([once(p7, 'connect'), once(p8, 'connect')]);

      const r7 = await emitAck(p7, 'room:create', { nickname: 'Sabır' });
      await emitAck(p8, 'room:join', { roomCode: r7.roomCode, nickname: 'Kaçan' });

      const startLog = [];
      p7.on('game:start', (payload) => startLog.push(payload));

      // Dinleyicileri EMİT'TEN ÖNCE tak (ikinci ready ack'i dönerken server
      // countdown'u hemen broadcast eder — sonra taklanırsa event kaçar)
      const cd7 = once(p7, 'game:countdown', { timeout: 5_000 });

      await emitAck(p7, 'game:ready', { ready: true });
      await emitAck(p8, 'game:ready', { ready: true });
      await cd7; // geri sayım başladı

      // Dinleyicileri TETİKLEYİCİDEN ÖNCE tak (disconnect senkron broadcast'ler)
      const leftP = once(p7, 'room:playerLeft', { timeout: 4_000 });
      const lobbyP = once(p7, 'room:state', { filter: (st) => st.state === 'LOBBY' });
      p8.disconnect(); // şimdi kaç

      const left = await leftP;
      expect(left.nickname).toBe('Kaçan');
      const lobby = await lobbyP;
      expect(lobby.players.find((p) => p.nickname === 'Kaçan').connected).toBe(false);

      // geri sayım süresi + pay geçmesine rağmen oyun başlamadı
      await sleep(config.COUNTDOWN_MS + 1_500);
      expect(startLog).toHaveLength(0);

      // host tekrar hazır olabilir (state LOBBY'ye döndü)
      const readyRes = await emitAck(p7, 'game:ready', { ready: false });
      expect(readyRes.ok).toBe(true);
    } finally {
      config.COUNTDOWN_MS = origCountdown;
    }
  });
});

describe('prod topoloji guard\'ları — Caddy arkası (XFF + CORS)', () => {
  it('XFF: join rate-limit Caddy zincirindeki SON IP\'ye keyed — spoof edilen ilk hop yok sayılır', async () => {
    // Prod: tarayıcı → Caddy → 127.0.0.1:8766. Caddy XFF zincirinin sonuna gerçek
    // client IP ekler. İlk hop client tarafından taklit edilebilir → son hop kullan.
    const c = io(URL, {
      path: `${config.BASE_PATH}/socket.io`,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' },
    });
    clients.push(c);
    await once(c, 'connect');

    const r = await emitAck(c, 'room:join', { roomCode: 'ZZZZ', nickname: 'xffprobe' });
    expect(r.ok).toBe(false); // oda yok — ama deneme IP bazlı kaydedilmiş olmalı
    expect(manager.joinAttempts.has('203.0.113.7')).toBe(true); // zincirin SON elemanı
    expect(manager.joinAttempts.has('9.9.9.9')).toBe(false); // spoof edilen ilk hop DEĞİL
    // (127.0.0.1 bu dosyadaki önceki testlerden zaten dolu olabilir — bu test onu iddia etmez)
  });

  it('XFF: Caddy yoksa (lokal dev, header yok) gerçek adres kullanılır', async () => {
    const c = connect();
    await once(c, 'connect');
    await emitAck(c, 'room:join', { roomCode: 'ZZZZ', nickname: 'devprobe' });
    expect(manager.joinAttempts.has('127.0.0.1')).toBe(true);
  });

  it('CORS: prod origin (nip.io) polling handshake\'inde Access-Control-Allow-Origin alır (mobil WS-engelli fallback)', async () => {
    const res = await fetch(`${URL}${config.BASE_PATH}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'https://178-105-90-130.nip.io' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://178-105-90-130.nip.io');
  });

  it('CORS: dev origin (localhost:8765) whitelist\'te kalır', async () => {
    const res = await fetch(`${URL}${config.BASE_PATH}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'http://localhost:8765' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8765');
  });
});
