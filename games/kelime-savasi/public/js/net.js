/**
 * Kelime Savaşı — net.js
 * Dual-mode ağ arayüzü: window.KSNet
 *   mode: 'mock'   → BroadcastChannel ile AYNI tarayıcıda 2 sekme gerçekçi multiplayer
 *   mode: 'socket' → /<BASE_PATH>/socket.io üzerine socket.io-client (Faz 2'de doldurulacak)
 *
 * Seçim: URL ?mock=1 → mock | ?socket=1 → socket | default: mock (backend Faz 2'de)
 * localStorage anahtarları: ks_playerToken, ks_nickname (main.js yönetir)
 *
 * Arayüz:
 *   KSNet.createRoom(nickname) → Promise<{ok, roomCode, playerToken, playerId}>
 *   KSNet.joinRoom(code, nickname) → Promise<{ok, playerToken, playerId, host} | {ok:false, error}>
 *   KSNet.setReady(ready) → Promise<{ok}>
 *   KSNet.submitWord(word) → Promise<{ok, word, points, totalScore} | {ok:false, reason}>
 *   KSNet.reconnect(token) → Promise<tam oda state'i | {ok:false, error}>
 *   KSNet.playAgain() → Promise (aynı rakiple yeni tur)
 *   KSNet.leave()
 *   KSNet.on(event, cb) / KSNet.off(event, cb)
 *
 * Olaylar (Faz 2 socket kontratı ile aynı isimler):
 *   room:state {players, state}            — lobi/oyun durum anlık görüntüsü
 *   room:playerJoined {nickname}
 *   room:playerLeft {nickname}
 *   game:countdown {endsAt}
 *   game:start {letters, duration, endsAt}
 *   word:accepted {nickname, word, points, score}
 *   game:timeSync {endsAt}
 *   game:end {results, winner, winnerNickname, reason, solutionList}
 *   game:rematch {}
 *   net:down {}                            — (mock) oda sahibi sekmesi kapandı
 */
'use strict';

/* ============================================================
 * Ortak yardımcılar — Türkçe harf duyarlı
 * ============================================================ */

/** Türkçe-aware lowercase: İ→i, I→ı (toLocaleLowerCase('tr') tek başına güvenilir değil) */
function trLower(s) {
  const map = { 'İ': 'i', 'I': 'ı' };
  return Array.from(String(s)).map((ch) => map[ch] ?? ch.toLowerCase()).join('');
}

/** Kelime normalizasyonu: lowercase + uzun üye düzeltme (â→a, î→i, û→u) + trim */
function normalizeWord(raw) {
  return trLower(String(raw ?? ''))
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .trim();
}

const WORD_RE = /^[a-zçğıöşü]{3,6}$/;

/** Puan tablosu (plan Task 6): 3→10, 4→25, 5→50, 6→100 */
const POINTS = { 3: 10, 4: 25, 5: 50, 6: 100 };
function wordPoints(word) { return POINTS[String(word).length] ?? 0; }

/** Kelime, harf dizisinin alt-çokluğu mu? (multiset subset kontrolü) */
function isSubset(word, letters) {
  const pool = Array.from(letters);
  for (const ch of word) {
    const i = pool.indexOf(ch);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return true;
}

/** Verilen harflerden türetilebilen tüm sözlük kelimeleri */
function solutionsFor(letters, dict) {
  return dict.filter((w) => isSubset(w, letters));
}

/* ============================================================
 * MOCK MİNİ SÖZLÜK — ~300 yaygın 3-6 harfli Türkçe kelime
 * (Faz 2'de sunucu tarafındaki 32K kelimelik tam sözlük geçerli;
 *  mock modda hızlı oynanabilirlik için gömülü liste)
 * ============================================================ */
const MINI_DICT = [
  // 3 harf
  'ada', 'ağa', 'alt', 'ana', 'arı', 'art', 'aşk', 'ata', 'ayı', 'aşı',
  'bak', 'bal', 'bas', 'bat', 'bay', 'bey', 'boz', 'bul', 'bun', 'buz',
  'çağ', 'cam', 'çok', 'dal', 'dar', 'def', 'diş', 'dok', 'dol', 'dut',
  'dua', 'duy', 'düş', 'erk', 'fil', 'gen', 'göl', 'göz', 'gül', 'güz',
  'hal', 'ham', 'has', 'hat', 'hep', 'jet', 'kan', 'kar', 'kas', 'kat',
  'kay', 'kaz', 'kez', 'kıl', 'kır', 'kız', 'koy', 'kul', 'kut',
  'kuş', 'laf', 'leh', 'muz', 'nar', 'oda', 'oka', 'örs',
  'ova', 'pak', 'par', 'pas', 'pek', 'pus', 'raf', 'saf', 'sal', 'san',
  'sap', 'sat', 'sav', 'say', 'saz', 'sev', 'sık', 'sok', 'son', 'sor',
  'sus', 'şah', 'şal', 'şap', 'taş', 'tay', 'tek', 'tel', 'top', 'tur',
  'var', 'vaz', 'yağ', 'yak', 'yap', 'yar', 'yay', 'yaz', 'yıl', 'yol',
  'yön', 'yük', 'zat', 'zar',
  'alp', 'anı', 'asa', 'kap', 'pul', 'sır', 'tas', 'tav',
  // 4 harf
  'adak', 'alan', 'artı', 'aynı', 'bank', 'blok', 'dama', 'kaba',
  'kapı', 'kapan', 'kara', 'kaş', 'kalp', 'kola', 'korse', 'lup',
  'naz', 'palan', 'para', 'plan', 'sana', 'şan', 'usul', 'vana', 'yal',
  'adam', 'ahır', 'akıl', 'anne', 'arpa', 'ataç', 'ateş', 'atık',
  'ayna', 'ayva', 'baba', 'bina', 'boya', 'burç', 'çare', 'çatı', 'çile',
  'dert', 'dost', 'dört', 'ekşi', 'elma', 'emir', 'erik', 'eski', 'etek',
  'ezan', 'fare', 'gece', 'gemi', 'gıda', 'hava', 'hece', 'ışık', 'ilaç',
  'inek', 'ılık', 'kaya', 'kedi', 'kına', 'kira', 'kısa', 'koku', 'kuru',
  'kuzu', 'küpe', 'masa', 'nane', 'nota', 'ocak', 'okul', 'omuz',
  'otel', 'oyun', 'ömür', 'örgü', 'renk', 'sarı', 'sayı', 'sera', 'soba',
  'tepe', 'tren', 'ufuk', 'uyku', 'uzay', 'üzüm', 'vazo', 'yaka', 'zeka',
  // 5 harf
  'atım', 'kanıt', 'lama', 'tanık',
  'armut', 'aslan', 'badem', 'balık', 'barut', 'biber', 'bulut', 'ceviz',
  'çamur', 'çınar', 'çiçek', 'çuval', 'defne', 'deniz', 'dikiş', 'duvar',
  'ekmek', 'göbek', 'gölge', 'gümüş', 'güneş', 'hamsi', 'horoz', 'incir',
  'kanat', 'kaşık', 'katır', 'kavun', 'kiraz', 'kılıç', 'kitap', 'komşu',
  'koyun', 'köpek', 'kuşak', 'limon', 'lodos', 'martı', 'mesaj', 'moloz',
  'orman', 'ördek', 'pamuk', 'pilav', 'piliç', 'radyo', 'rahat', 'resim',
  'sabun', 'salça', 'sanat', 'sıcak', 'sinek', 'simit', 'şahin', 'şeker',
  'şehir', 'tabak', 'tarak', 'tarla', 'tavuk', 'tayfa', 'torba', 'tulum',
  'tuzlu', 'üstün', 'yalan', 'yatak', 'yemek', 'yılan', 'yosun', 'yüzük',
  'zafer', 'zebra', 'zincir',
  // 6 harf (puzzle tohum adayları)
  'balkon', 'baraka', 'bardak', 'burada', 'ceylan', 'demlik', 'fındık',
  'kanepe', 'kaplan', 'kardeş', 'karpuz', 'kayısı', 'kement', 'konser',
  'korsan', 'lahana', 'mandal', 'mantık', 'meltem', 'mercan', 'misket',
  'miskin', 'otobüs', 'pirinç', 'pusula', 'salata', 'sandal', 'sarnıç',
  'sinema', 'sultan', 'tarçın', 'tavşan', 'teknik', 'yağmur', 'yalnız',
  'yaprak', 'yastık', 'yıldız', 'zambak', 'zeytin', 'zümrüt', 'zürafa',
].sort();

const DICT_SET = new Set(MINI_DICT);

/* ============================================================
 * Seedli RNG + puzzle üretimi (mock)
 * ============================================================ */

function hashSeed(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN_MOCK_SOLUTIONS = 8;
let _candidateCache = null;

/** 6 harfli sözlük kelimesi tohumlarından, mini sözlükte ≥8 çözümlü adaylar */
function mockCandidates() {
  if (_candidateCache) return _candidateCache;
  _candidateCache = MINI_DICT
    .filter((w) => w.length === 6)
    .map((word) => {
      const letters = Array.from(word);
      const solutions = solutionsFor(letters, MINI_DICT);
      return { letters, solutions };
    })
    .filter((c) => c.solutions.length >= MIN_MOCK_SOLUTIONS);
  return _candidateCache;
}

/** Sabit tohumdan puzzle: harfler KARIŞTIRILMIŞ olarak döner (tohum kelime sırası sızmasın) */
function pickPuzzle(seedKey) {
  const cands = mockCandidates();
  if (!cands.length) {
    // Teorik olarak olmaz — savunma amaçlı sabit fallback
    const letters = ['e', 'l', 'm', 'a', 'k', 'ı'];
    return { letters, solutions: solutionsFor(letters, MINI_DICT) };
  }
  const rng = mulberry32(hashSeed(seedKey));
  const pick = cands[Math.floor(rng() * cands.length)];
  const letters = Array.from(pick.letters);
  // Fisher-Yates karıştır (aynı tohum → aynı dizilim, iki sekme tutarlı)
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  return { letters, solutions: pick.solutions };
}

/* ============================================================
 * MockNet — BroadcastChannel tabanlı aynı-tarayıcı multiplayer
 * ODA SAHİBİ (p1) sekmesi = otorite: puzzle, sayaç, doğrulama, sonuç
 * ============================================================ */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ'; // I, L, O, U hariç — belirsizlik yok
const HB_INTERVAL = 1200;
/*
 * Not: Aynı pencerede 2 sekme kullanılırsa gizli sekmenin timer'ları Chrome
 * tarafından throttle/freeze edilebilir. Bu yüzden presence MESAJ-TEMELLİDİR:
 * her gelen mesaj liveness sayılır (piggyback); interval yedektir.
 */
const HB_TIMEOUT = 15_000;
const JOIN_TIMEOUT = 1600;
const ACK_TIMEOUT = 3000;
const GAME_DURATION = 90_000;
const COUNTDOWN_DURATION = 3000;
const TIMESYNC_INTERVAL = 5000;

class MockNet {
  constructor() {
    this.mode = 'mock';
    this._listeners = new Map();
    this._ch = null;
    this._ctx = Math.random().toString(36).slice(2); // kendi mesajlarımı filtrele
    this._timers = new Set();
    this._pending = new Map(); // reqId → {resolve, timer}
    this._you = null;          // {id, nickname, token}
    this._code = null;
    this._isHost = false;
    this._game = null;         // host: otoriter state; guest: sonroom:state kopyası
    this._lastSeen = new Map();
    this._downEmitted = false;
    this._reqSeq = 0;
  }

  /* ---- olay dağıtımı ---- */
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
  }

  off(event, cb) {
    this._listeners.get(event)?.delete(cb);
  }

  _emit(event, payload) {
    this._listeners.get(event)?.forEach((cb) => {
      try { cb(payload); } catch (err) { console.error(`[KSNet] ${event} handler`, err); }
    });
  }

  /* ---- zamanlayıcı yardımcıları (leave'de hepsi temizlenir) ---- */
  _every(ms, fn) {
    const t = setInterval(fn, ms);
    this._timers.add(t);
    return t;
  }

  _after(ms, fn) {
    const t = setTimeout(fn, ms);
    this._timers.add(t);
    return t;
  }

  _clearTimers() {
    this._timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    this._timers.clear();
    this._pending.forEach(({ timer }) => clearTimeout(timer));
    this._pending.clear();
  }

  _post(msg) {
    if (!this._ch) return;
    this._ch.postMessage({ ...msg, _ctx: this._ctx });
  }

  _openChannel(code) {
    this._closeChannel();
    this._code = code;
    this._ch = new BroadcastChannel(`ks-room-${code}`);
    this._ch.onmessage = (ev) => this._onMessage(ev.data);
  }

  _closeChannel() {
    if (this._ch) { try { this._ch.close(); } catch { /* yoksay */ } }
    this._ch = null;
  }

  /* ================= ODA KUR ================= */
  async createRoom(nickname) {
    const clean = String(nickname || '').trim().slice(0, 16);
    if (clean.length < 2) return { ok: false, error: 'Geçersiz takma ad' };

    let code = '';
    do {
      code = Array.from({ length: 4 }, () =>
        CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    } while (code.startsWith('X')); // X önekini ciddi görünsün diye atla (jest)

    this._openChannel(code);
    this._isHost = true;
    this._downEmitted = false;

    const token = `${code}.p1.${Math.random().toString(36).slice(2, 10)}`;
    this._you = { id: 'p1', nickname: clean, token };

    this._game = {
      state: 'LOBBY',
      round: 0,
      letters: null,
      endsAt: 0,
      solutions: [],
      players: {
        p1: { id: 'p1', nickname: clean, token, ready: false, score: 0, words: [], connected: true },
      },
    };
    this._lastSeen.set('p1', Date.now());

    this._startPresence();

    // Torpil: oda sahibi doğrudan state bilir
    this._after(0, () => this._emit('room:state', this._publicState()));
    return { ok: true, roomCode: code, playerToken: token, playerId: 'p1' };
  }

  /* ================= ODAYA KATIL ================= */
  async joinRoom(code, nickname) {
    const clean = String(nickname || '').trim().slice(0, 16);
    const roomCode = String(code || '').trim().toUpperCase();
    if (clean.length < 2) return { ok: false, error: 'Geçersiz takma ad' };
    if (!/^[A-Z]{4}$/.test(roomCode)) return { ok: false, error: 'Kod 4 harfli olmalı' };

    this._openChannel(roomCode);
    this._isHost = false;
    this._downEmitted = false;

    const token = `${roomCode}.p2.${Math.random().toString(36).slice(2, 10)}`;
    this._you = { id: 'p2', nickname: clean, token };

    const reply = await new Promise((resolve) => {
      const reqId = `join-${++this._reqSeq}-${Math.random().toString(36).slice(2, 7)}`;
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        resolve({ ok: false, error: 'Oda bulunamadı' });
      }, JOIN_TIMEOUT);
      this._pending.set(reqId, { resolve, timer });
      this._post({ t: 'join', reqId, nickname: clean, token });
    });

    if (!reply.ok) { this.leave(); return reply; }

    this._startPresence();
    return {
      ok: true,
      playerToken: token,
      playerId: 'p2',
      host: { nickname: reply.hostNickname },
      roomCode,
    };
  }

  /* ================= RECONNECT ================= */
  async reconnect(token) {
    const raw = String(token || '');
    const [code, pid] = raw.split('.');
    if (!code || !pid) return { ok: false, error: 'Geçersiz token' };

    this._openChannel(code);
    this._isHost = false;
    this._downEmitted = false;

    const reply = await new Promise((resolve) => {
      const reqId = `rc-${++this._reqSeq}-${Math.random().toString(36).slice(2, 7)}`;
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        resolve({ ok: false, error: 'Oda bulunamadı' });
      }, JOIN_TIMEOUT);
      this._pending.set(reqId, { resolve, timer });
      this._post({ t: 'reconnectReq', reqId, token: raw });
    });

    if (!reply.ok) { this.leave(); return reply; }

    this._you = { id: pid, nickname: reply.you.nickname, token: raw };
    this._startPresence();

    // room:state zaten reconnectState içinde — UI'ya ilet
    this._after(0, () => this._emit('room:state', reply.roomState));
    return reply;
  }

  /* ================= HAZIR ================= */
  async setReady(ready) {
    if (!this._you) return { ok: false, error: 'Oda yok' };
    if (this._isHost) {
      this._handleReady('p1', !!ready);
      return { ok: true };
    }
    this._post({ t: 'ready', pid: this._you.id, ready: !!ready });
    return { ok: true };
  }

  /* ================= KELİME GÖNDER ================= */
  async submitWord(word) {
    if (!this._you) return { ok: false, reason: 'not_playing' };
    const normalized = normalizeWord(word);

    if (this._isHost) {
      // Oda sahibi de doğrularken YAYIN yapmalı — rakip skoru görsün
      return this._hostAccept('p1', normalized);
    }

    return new Promise((resolve) => {
      const reqId = `w-${++this._reqSeq}-${Math.random().toString(36).slice(2, 7)}`;
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        resolve({ ok: false, reason: 'timeout' });
      }, ACK_TIMEOUT);
      this._pending.set(reqId, { resolve, timer });
      this._post({ t: 'submit', reqId, pid: this._you.id, word: normalized });
    });
  }

  /* ================= TEKRAR OYNA ================= */
  async playAgain() {
    if (this._isHost) { this._hostRematch(); return { ok: true }; }
    this._post({ t: 'rematchReq' });
    return { ok: true };
  }

  /* ================= AYRIL ================= */
  leave() {
    if (this._ch && this._you) {
      this._post({ t: 'leave', pid: this._you.id, host: this._isHost });
    }
    this._clearTimers();
    this._closeChannel();
    this._isHost = false;
    this._game = null;
    this._you = null;
    this._code = null;
    this._lastSeen.clear();
    this._downEmitted = false;
  }

  /* ============================================================
   * HAZIRLIK — heartbeat + watchdog
   * ============================================================ */
  _startPresence() {
    this._every(HB_INTERVAL, () => {
      this._post({ t: 'hb', pid: this._you?.id, host: this._isHost, nickname: this._you?.nickname });
    });

    this._every(2000, () => {
      const now = Date.now();

      if (this._isHost) {
        for (const [pid, ts] of this._lastSeen) {
          if (pid === this._you.id || pid === 'host') continue;
          if (now - ts > HB_TIMEOUT) {
            this._lastSeen.delete(pid);
            const g = this._game;
            if (g?.players[pid]) {
              const nick = g.players[pid].nickname;
              // PLAYING'de asla oyuncu silme (plan Task 7 grace — reconnect hakkı)
              if (g.state === 'PLAYING') {
                if (g.players[pid].connected) {
                  g.players[pid].connected = false;
                  const st = this._publicState();
                  this._post({ t: 'state', roomState: st });
                  this._emit('room:state', st);
                }
                continue;
              }
              delete g.players[pid];
              // COUNTDOWN'da ayrılma → LOBBY'ye dönüş (plan Task 7)
              if (g.state === 'COUNTDOWN') { g.state = 'LOBBY'; this._cancelCountdown(); }
              this._post({ t: 'playerLeft', nickname: nick });
              this._emit('room:playerLeft', { nickname: nick });
              const st = this._publicState();
              this._post({ t: 'state', roomState: st });
              this._emit('room:state', st);
            }
          }
        }
      } else {
        const hostSeen = this._lastSeen.get('host') ?? 0;
        if (hostSeen && now - hostSeen > HB_TIMEOUT && !this._downEmitted) {
          this._downEmitted = true;
          this._emit('net:down', {});
        }
      }
    });
  }

  /* ============================================================
   * HOST — otoriter oyun mantığı
   * ============================================================ */
  _handleReady(pid, ready) {
    const g = this._game;
    if (!g?.players[pid] || g.state !== 'LOBBY') return;
    g.players[pid].ready = ready;

    const st = this._publicState();
    this._post({ t: 'state', roomState: st });
    this._emit('room:state', st);

    const all = Object.values(g.players);
    if (all.length === 2 && all.every((p) => p.ready)) this._hostStartCountdown();
  }

  _hostStartCountdown() {
    const g = this._game;
    if (!g || g.state !== 'LOBBY' || Object.keys(g.players).length < 2) return;
    g.state = 'COUNTDOWN';
    g.endsAt = Date.now() + COUNTDOWN_DURATION;

    const payload = { endsAt: g.endsAt };
    this._post({ t: 'countdown', ...payload });
    this._emit('game:countdown', payload);

    this._countdownTimer = this._after(COUNTDOWN_DURATION, () => this._hostStartGame());
  }

  _cancelCountdown() {
    if (this._countdownTimer) { clearTimeout(this._countdownTimer); this._timers.delete(this._countdownTimer); this._countdownTimer = null; }
  }

  _hostStartGame() {
    const g = this._game;
    if (!g || g.state !== 'COUNTDOWN') return;
    g.round += 1;
    g.state = 'PLAYING';

    const { letters, solutions } = pickPuzzle(`${this._code}#${g.round}`);
    g.letters = letters;
    g.solutions = solutions;
    g.endsAt = Date.now() + GAME_DURATION;
    for (const p of Object.values(g.players)) { p.score = 0; p.words = []; }

    const payload = { letters, duration: GAME_DURATION, endsAt: g.endsAt };
    this._post({ t: 'start', ...payload });
    this._emit('game:start', payload);

    this._every(TIMESYNC_INTERVAL, () => {
      if (this._game?.state !== 'PLAYING') return;
      this._post({ t: 'timeSync', endsAt: this._game.endsAt });
      this._emit('game:timeSync', { endsAt: this._game.endsAt });
    });

    this._endTimer = this._after(GAME_DURATION, () => this._hostEndGame('time_up'));
  }

  _validateWord(pid, word) {
    const g = this._game;
    const p = g?.players[pid];
    if (!g || !p) return { ok: false, reason: 'not_playing' };
    if (g.state !== 'PLAYING') return { ok: false, reason: 'not_playing' };
    if (Date.now() >= g.endsAt) return { ok: false, reason: 'time_up' };
    if (!WORD_RE.test(word)) {
      return { ok: false, reason: word.length < 3 ? 'too_short' : 'invalid_chars' };
    }
    if (!isSubset(word, g.letters)) return { ok: false, reason: 'not_subset' };
    if (!DICT_SET.has(word)) return { ok: false, reason: 'not_in_dict' };
    if (p.words.some((w) => w.word === word)) return { ok: false, reason: 'duplicate' };

    const points = wordPoints(word);
    p.words.push({ word, points });
    p.score += points;
    return { ok: true, points, totalScore: p.score };
  }

  _hostAccept(pid, word) {
    const g = this._game;
    const p = g.players[pid];
    const res = this._validateWord(pid, word);
    if (!res.ok) return { ok: false, word, reason: res.reason };

    const payload = { id: pid, nickname: p.nickname, word, points: res.points, score: p.score };
    this._post({ t: 'accepted', ...payload });
    this._emit('word:accepted', payload);
    return { ok: true, word, points: res.points, totalScore: p.score };
  }

  _hostEndGame(reason) {
    const g = this._game;
    if (!g || g.state !== 'PLAYING') return;
    g.state = 'RESULTS';

    const results = Object.values(g.players).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score,
      words: p.words.map((w) => ({ ...w })),
      longWords: p.words.filter((w) => w.word.length >= 5).length,
    }));

    // Kazanan zinciri: skor → uzun kelime → toplam kelime → berabere (plan Task 6)
    let winner = 'tie';
    if (results.length === 2) {
      const [a, b] = results;
      if (a.score !== b.score) winner = a.score > b.score ? a.id : b.id;
      else if (a.longWords !== b.longWords) winner = a.longWords > b.longWords ? a.id : b.id;
      else if (a.words.length !== b.words.length) winner = a.words.length > b.words.length ? a.id : b.id;
    }

    const payload = {
      results,
      winner,
      winnerNickname: winner === 'tie' ? null : results.find((r) => r.id === winner)?.nickname,
      reason,
      solutionList: g.solutions.slice().sort((x, y) => y.length - x.length || x.localeCompare(y, 'tr')),
    };
    g.lastEnd = payload; // RESULTS'ta reconnect için sakla
    this._post({ t: 'end', ...payload });
    this._emit('game:end', payload);
  }

  _hostRematch() {
    const g = this._game;
    if (!g) return;
    g.state = 'LOBBY';
    g.letters = null;
    g.endsAt = 0;
    g.lastEnd = null;
    for (const p of Object.values(g.players)) { p.ready = false; p.score = 0; p.words = []; p.connected = true; }

    this._post({ t: 'rematch' });
    this._emit('game:rematch', {});
    const st = this._publicState();
    this._post({ t: 'state', roomState: st });
    this._emit('room:state', st);
  }

  _publicState() {
    const g = this._game;
    if (!g) return { players: [], state: 'LOBBY' };
    return {
      state: g.state,
      players: Object.values(g.players).map((p) => ({
        id: p.id, nickname: p.nickname, ready: p.ready, connected: p.connected,
      })),
    };
  }

  /* ============================================================
   * MESAJ İŞLEME (hem host hem guest)
   * ============================================================ */
  _onMessage(msg) {
    if (!msg || msg._ctx === this._ctx) return;

    // Piggyback liveness: her mesaj karşımızdaolduğunu kanıtlar (timer-bağımsız presence)
    if (msg.pid && this._isHost && this._game?.players[msg.pid]) {
      this._lastSeen.set(msg.pid, Date.now());
    }
    if (!this._isHost && (msg.t === 'hb' || msg.host)) {
      this._lastSeen.set('host', Date.now());
    }
    if (!this._isHost) this._lastSeen.set('host', Date.now()); // host yayınları her zaman liveness

    // ---- hedefli cevaplar (reqId eşleşen promise'i çözer) ----
    if (msg.t === 'ack' && msg.reqId && this._pending.has(msg.reqId)) {
      const { resolve, timer } = this._pending.get(msg.reqId);
      clearTimeout(timer);
      this._pending.delete(msg.reqId);
      resolve(msg.data);
      return;
    }

    // ---- host: guest istekleri ----
    if (this._isHost) {
      switch (msg.t) {
        case 'join': {
          const g = this._game;
          if (!g || g.state !== 'LOBBY') {
            this._post({ t: 'ack', reqId: msg.reqId, data: { ok: false, error: 'Oda müsait değil' } });
            return;
          }
          if (g.players.p2) {
            this._post({ t: 'ack', reqId: msg.reqId, data: { ok: false, error: 'Oda dolu' } });
            return;
          }
          g.players.p2 = {
            id: 'p2', nickname: String(msg.nickname).slice(0, 16), token: msg.token,
            ready: false, score: 0, words: [], connected: true,
          };
          this._lastSeen.set('p2', Date.now());
          this._post({ t: 'ack', reqId: msg.reqId, data: { ok: true, hostNickname: g.players.p1.nickname } });
          this._post({ t: 'playerJoined', nickname: msg.nickname });
          this._emit('room:playerJoined', { nickname: g.players.p2.nickname });
          const st = this._publicState();
          this._post({ t: 'state', roomState: st });
          this._emit('room:state', st);
          return;
        }

        case 'reconnectReq': {
          const g = this._game;
          const pid = String(msg.token).split('.')[1];
          const p = g?.players[pid];
          if (!p || p.token !== msg.token) {
            this._post({ t: 'ack', reqId: msg.reqId, data: { ok: false, error: 'Oda bulunamadı' } });
            return;
          }
          this._lastSeen.set(pid, Date.now());
          p.connected = true;

          const roomState = this._publicState();
          const reply = {
            ok: true,
            state: g.state,
            roomState,
            code: this._code,
            you: {
              id: p.id, nickname: p.nickname, score: p.score,
              words: p.words.map((w) => ({ ...w })), ready: p.ready,
            },
            opponent: (() => {
              const o = Object.values(g.players).find((x) => x.id !== p.id);
              return o ? { id: o.id, nickname: o.nickname, score: o.score, words: o.words.map((w) => ({ ...w })), connected: o.connected } : null;
            })(),
            letters: g.letters,
            endsAt: g.endsAt,
            duration: GAME_DURATION,
            lastEnd: g.state === 'RESULTS' ? (g.lastEnd ?? null) : null,
          };
          this._post({ t: 'ack', reqId: msg.reqId, data: reply });
          // Rakibe güncel state haber ver
          this._post({ t: 'state', roomState });
          return;
        }

        case 'ready':
          this._lastSeen.set(msg.pid, Date.now());
          this._handleReady(msg.pid, !!msg.ready);
          return;

        case 'submit': {
          this._lastSeen.set(msg.pid, Date.now());
          const res = this._hostAccept(msg.pid, normalizeWord(msg.word));
          this._post({ t: 'ack', reqId: msg.reqId, data: res });
          return;
        }

        case 'rematchReq':
          if (this._game?.state === 'RESULTS' || this._game?.state === 'LOBBY') this._hostRematch();
          return;

        case 'leave': {
          const g = this._game;
          if (g?.players[msg.pid]) {
            const nick = g.players[msg.pid].nickname;
            delete g.players[msg.pid];
            this._lastSeen.delete(msg.pid);
            if (g.state === 'COUNTDOWN') { g.state = 'LOBBY'; this._cancelCountdown(); }
            if (g.state === 'PLAYING' || g.state === 'RESULTS') {
              // mock: oyun bitmiş/oyunda ayrılma — kalan oyuncuya bildir, oyun akışta ise devam
              this._post({ t: 'playerLeft', nickname: nick });
              this._emit('room:playerLeft', { nickname: nick });
              if (g.state === 'PLAYING') this._hostEndGame('opponent_left');
            }
            const st = this._publicState();
            this._post({ t: 'state', roomState: st });
            this._emit('room:state', st);
          }
          return;
        }

        case 'hb': {
          if (msg.host) this._lastSeen.set('host', Date.now());
          if (msg.pid && this._game?.players[msg.pid]) {
            this._lastSeen.set(msg.pid, Date.now());
            if (!this._game.players[msg.pid].connected) {
              this._game.players[msg.pid].connected = true;
              const st = this._publicState();
              this._post({ t: 'state', roomState: st });
              this._emit('room:state', st);
            }
          }
          return;
        }
      }
      return; // host, host mesajlarını dinlemez
    }

    // ---- guest: host yayınları ----
    switch (msg.t) {
      case 'hb':
        if (msg.host) this._lastSeen.set('host', Date.now());
        if (this._downEmitted) { this._downEmitted = false; this._emit('room:recovered', {}); }
        return;

      case 'playerJoined':
        this._emit('room:playerJoined', { nickname: msg.nickname });
        return;

      case 'playerLeft':
        this._emit('room:playerLeft', { nickname: msg.nickname });
        return;

      case 'state':
        this._emit('room:state', msg.roomState);
        return;

      case 'countdown':
        this._emit('game:countdown', { endsAt: msg.endsAt });
        return;

      case 'start':
        this._emit('game:start', { letters: msg.letters, duration: msg.duration, endsAt: msg.endsAt });
        return;

      case 'accepted':
        this._emit('word:accepted', { id: msg.id, nickname: msg.nickname, word: msg.word, points: msg.points, score: msg.score });
        return;

      case 'timeSync':
        // Mesaj-temelli presence: host yayınını al = canlıyım diye cevapla
        // (gizli sekmede interval throttle edilebilir — bu yol her zaman çalışır)
        this._post({ t: 'hb', pid: this._you?.id, host: false });
        this._emit('game:timeSync', { endsAt: msg.endsAt });
        return;

      case 'end':
        this._emit('game:end', {
          results: msg.results, winner: msg.winner, winnerNickname: msg.winnerNickname,
          reason: msg.reason, solutionList: msg.solutionList,
        });
        return;

      case 'rematch':
        this._emit('game:rematch', {});
        return;
    }
  }
}

/* ============================================================
 * SocketNet — Faz 2 stub
 * socket.io-client <script> eklendiğinde (window.io) çalışır.
 * TODO(FAZ 2):
 *   1. index.html'e <script src="{BASE_PATH}/socket.io/socket.io.js"></script> ekle
 *   2. Sunucu event adları/mock payload'ları birebir örtüşüyor (server/index.js TODO notu)
 *   3. Reconnect: socket.io otomatik reconnect + 'connect' → room:reconnect replay
 * ============================================================ */
class SocketNet {
  constructor() {
    this.mode = 'socket';
    this._listeners = new Map();
    this._socket = null;
    this._connected = false;
  }

  _ensureLib() {
    if (typeof window === 'undefined' || !window.io) {
      const err = { ok: false, error: 'socket.io-client yüklenmedi (Faz 2)' };
      throw err;
    }
  }

  _connect() {
    this._ensureLib();
    if (this._socket) return this._socket;
    // Path: /<BASE_PATH>/socket.io — server config.js BASE_PATH ile aynı
    this._socket = window.io({
      path: `${BASE_PATH}/socket.io`,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
    });

    const bridge = [
      'room:state', 'room:playerJoined', 'room:playerLeft',
      'game:countdown', 'game:start', 'game:timeSync', 'game:end',
      'word:accepted', 'game:rematch', 'error',
    ];
    for (const ev of bridge) {
      this._socket.on(ev, (payload) => this._emit(ev, payload));
    }

    this._socket.on('connect', () => {
      this._connected = true;
      this._emit('net:up', {});
    });
    this._socket.on('disconnect', () => {
      this._connected = false;
      this._emit('net:down', {});
    });
    return this._socket;
  }

  _ack(event, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (data) => { if (!settled) { settled = true; resolve(data ?? { ok: false, error: 'no_reply' }); } };
      const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 5000);
      try {
        this._connect().emit(event, payload, (reply) => { clearTimeout(timer); done(reply); });
      } catch (err) {
        clearTimeout(timer);
        resolve({ ok: false, error: err?.error || err?.message || 'bağlantı hatası' });
      }
    });
  }

  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    // TODO(FAZ 2): dinamik socket.on bridge (yukarıdaki sabit liste genişletilebilir)
  }

  off(event, cb) { this._listeners.get(event)?.delete(cb); }

  _emit(event, payload) {
    this._listeners.get(event)?.forEach((cb) => { try { cb(payload); } catch (e) { console.error(e); } });
  }

  createRoom(nickname) { return this._ack('room:create', { nickname }); }
  joinRoom(code, nickname) { return this._ack('room:join', { roomCode: code, nickname }); }
  reconnect(token) { return this._ack('room:reconnect', { playerToken: token }); }
  setReady(ready) { return this._ack('game:ready', { ready }); }
  submitWord(word) { return this._ack('word:submit', { word }); }
  playAgain() {
    // TODO(FAZ 2): sunucuda karşılığı yoksa 'game:rematch' event'i client→server eklenecek
    return this._ack('game:rematch', {});
  }
  leave() { try { this._socket?.disconnect(); } catch { /* yoksay */ } this._socket = null; }
}

/* ============================================================
 * Facade — window.KSNet
 * ============================================================ */

const BASE_PATH = (() => {
  // index.html /<base>/ altında servis ediliyor → '/games/kelime-savasi'
  const m = location.pathname.replace(/\/[^/]*$/, '');
  return m || '/';
})();

const qs = new URLSearchParams(location.search);
const mode = qs.get('socket') === '1' ? 'socket' : 'mock'; // default: mock (Faz 2'de değişir)

const impl = mode === 'socket' ? new SocketNet() : new MockNet();

window.KSNet = {
  mode,
  BASE_PATH,
  impl,
  createRoom: (n) => impl.createRoom(n),
  joinRoom: (c, n) => impl.joinRoom(c, n),
  reconnect: (t) => impl.reconnect(t),
  setReady: (r) => impl.setReady(r),
  submitWord: (w) => impl.submitWord(w),
  playAgain: () => impl.playAgain(),
  leave: () => impl.leave(),
  on: (ev, cb) => impl.on(ev, cb),
  off: (ev, cb) => impl.off(ev, cb),
};

export default window.KSNet;
export { trLower, normalizeWord, wordPoints, isSubset, solutionsFor, pickPuzzle, MINI_DICT, POINTS };
