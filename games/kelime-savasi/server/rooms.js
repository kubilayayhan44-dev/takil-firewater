// RoomManager (plan Task 4 + 7): oda yaşam döngüsü, üyelik, reconnect, GC.
//
// Sorumluluk ayrımı: rooms.js = oda/oyuncu kaydı + socket attach/detach + grace/GC;
// game.js = oyun state machine (countdown/playing/end). rooms.js → game.js tek yönlü.
//
// Dayanıklılık kuralları (plan Task 7):
//   LOBBY disconnect      → 60sn grace → dönmezse playerLeft (host ise oda kapanır)
//   COUNTDOWN disconnect  → anında LOBBY'ye dönüş + playerLeft, sonra LOBBY grace'i
//   PLAYING disconnect    → oyun DURMAZ, 30sn grace (socket detached) → reconnect ile devam;
//                          dönmezse playerLeft bildirilir ama maç timer'ı normal biter
//   RESULTS disconnect    → bildirim yok; oda RESULTS_TTL_MS sonra GC
//   Tüm timer'lar destroyRoom'da clear edilir (memory-leak guard).
//
// UI sözleşmesi (public/js/net.js mock'u ile birebir): error mesajları Türkçe ve
// mock'un döndürdüğü stringlerle aynı — UI bunları doğrudan gösteriyor.

import { randomUUID } from 'node:crypto';
import config from './config.js';
import {
  maybeStartCountdown,
  cancelCountdown,
  endGame,
  submitWord as gameSubmitWord,
  rematch as gameRematch,
} from './game.js';

const JOIN_BUSY_ERROR = 'Çok fazla deneme — biraz bekle';

/** Takma adı normalize et: trim + max uzunluk; çok kısaysa '' (UI mock kurallarıyla aynı). */
function normalizeNickname(nickname) {
  if (typeof nickname !== 'string') return '';
  const clean = nickname.trim().slice(0, config.NICKNAME.MAX_LEN);
  return clean.length >= config.NICKNAME.MIN_LEN ? clean : '';
}

/** Oda publicState — UI room:state payload'ı (mock _publicState ile aynı şekil). */
function publicStateOf(room) {
  return {
    state: room.state,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      ready: p.ready,
      connected: p.connected,
    })),
  };
}

export class RoomManager {
  constructor(opts = {}) {
    this.rooms = new Map(); // roomCode → room
    this.tokenIndex = new Map(); // playerToken → {roomCode, playerId}
    this.socketIndex = new Map(); // socketId → {roomCode, playerId}
    this.joinAttempts = new Map(); // ip → timestamp[]
    this.gcTimer = null;
    this.now = opts.now ?? Date.now; // fake-timer testleri için enjekte edilebilir
    this._startGc();
  }

  /* ============================================================
   * Oda kur / katıl / reconnect
   * ============================================================ */

  createRoom(nickname, socket, ip = 'unknown') {
    if (this.socketIndex.has(socket.id)) return { ok: false, error: 'Zaten bir odadasın' };
    const nick = normalizeNickname(nickname);
    if (!nick) return { ok: false, error: 'Geçersiz takma ad' };

    const code = this._generateRoomCode();
    const host = this._makePlayer(nick);
    const room = this._makeRoom(code, host);
    this.rooms.set(code, room);
    this._attach(socket, room, host);
    room.touch();
    room.broadcast('room:state', room.publicState());
    return { ok: true, roomCode: code, playerId: host.id, playerToken: host.token };
  }

  joinRoom(roomCode, nickname, socket, ip = 'unknown') {
    if (this.socketIndex.has(socket.id)) return { ok: false, error: 'Zaten bir odadasın' };
    if (!this._allowJoin(ip)) return { ok: false, error: JOIN_BUSY_ERROR };

    const nick = normalizeNickname(nickname);
    if (!nick) return { ok: false, error: 'Geçersiz takma ad' };

    const code = String(roomCode ?? '').trim().toUpperCase();
    if (!new RegExp(`^[A-Z]{${config.ROOM_CODE.LENGTH}}$`).test(code)) {
      return { ok: false, error: `Kod ${config.ROOM_CODE.LENGTH} harfli olmalı` };
    }

    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Oda bulunamadı' };
    if (room.state !== 'LOBBY') return { ok: false, error: 'Oda müsait değil' };
    if (room.players.size >= 2) return { ok: false, error: 'Oda dolu' };

    const host = room.players.get(room.hostId);
    const player = this._makePlayer(nick);
    room.players.set(player.id, player);
    this._attach(socket, room, player);
    room.touch();
    room.broadcast('room:playerJoined', { nickname: nick }, { exclude: player });
    room.broadcast('room:state', room.publicState());
    return {
      ok: true,
      roomCode: code,
      playerId: player.id,
      playerToken: player.token,
      host: { nickname: host?.nickname ?? '' },
    };
  }

  /**
   * Token ile yeniden bağlan: socket re-attach + TAM state replay.
   * Tek socket kuralı: yeni bağlantı eski socket'i düşürür.
   */
  reconnectByToken(token, socket) {
    const tok = typeof token === 'string' ? token : '';
    if (!tok) return { ok: false, error: 'Geçersiz token' };

    const entry = this.tokenIndex.get(tok);
    if (!entry) return { ok: false, error: 'Oda bulunamadı' };
    const room = this.rooms.get(entry.roomCode);
    const player = room?.players.get(entry.playerId);
    if (!room || !player) {
      this.tokenIndex.delete(tok);
      return { ok: false, error: 'Oda bulunamadı' };
    }

    if (player.socket !== socket) {
      const old = player.socket;
      if (old) {
        // Önce indeksten düşür: eski socket'in disconnect olayı no-op olmalı
        this.socketIndex.delete(old.id);
        player.socket = null;
      }
      // Socket başka bir odaya bağlıysa oradan sessizce ayır
      this._detachSocketIfAttached(socket);
      this._attach(socket, room, player);
      if (old && old.connected) old.disconnect(true);
    }

    player.connected = true;
    if (player.graceTimer) {
      clearTimeout(player.graceTimer);
      player.graceTimer = null;
    }
    room.touch();

    const opponent = room.opponentOf(player);
    const reply = {
      ok: true,
      state: room.state,
      roomState: room.publicState(),
      code: room.code,
      you: {
        id: player.id,
        nickname: player.nickname,
        score: player.score,
        words: player.words.map((w) => ({ ...w })),
        ready: player.ready,
      },
      opponent: opponent
        ? {
            id: opponent.id,
            nickname: opponent.nickname,
            score: opponent.score,
            words: opponent.words.map((w) => ({ ...w })),
            connected: opponent.connected,
          }
        : null,
      letters: room.letters,
      endsAt: room.endsAt,
      duration: config.GAME_DURATION_MS,
      lastEnd: room.state === 'RESULTS' ? room.lastEnd : null,
    };
    room.broadcast('room:state', room.publicState()); // rakip "geri geldi" görür
    return reply;
  }

  /* ============================================================
   * Socket event delegasyonu (index.js buraya bağlanır)
   * ============================================================ */

  setReady(socket, ready) {
    const { room, player } = this._resolve(socket);
    if (!room || !player) return { ok: false, error: 'Oda yok' };
    if (room.state !== 'LOBBY') return { ok: false, error: 'Şu anda hazır durumu değiştirilemez' };
    player.ready = !!ready;
    room.touch();
    room.broadcast('room:state', room.publicState());
    maybeStartCountdown(room); // ikisi de hazırsa → countdown (game.js)
    return { ok: true };
  }

  submitWord(socket, word) {
    const { room, player } = this._resolve(socket);
    if (!room || !player) return { ok: false, reason: 'not_playing' };
    return gameSubmitWord(room, player, word);
  }

  rematch(socket) {
    const { room } = this._resolve(socket);
    if (!room) return { ok: false, error: 'Oda yok' };
    return gameRematch(room);
  }

  /** Socket koptu — oda state'ine göre grace akışı (plan Task 7). */
  handleDisconnect(socket) {
    const entry = this.socketIndex.get(socket.id);
    if (!entry) return;
    this.socketIndex.delete(socket.id);

    const room = this.rooms.get(entry.roomCode);
    const player = room?.players.get(entry.playerId);
    if (!room || !player) return;

    player.socket = null;
    player.connected = false;
    room.touch();

    if (room.state === 'COUNTDOWN') {
      // Geri sayım bozuldu → LOBBY'ye dön + kalan oyuncuya haber (mock davranışı)
      cancelCountdown(room);
      room.broadcast('room:playerLeft', { nickname: player.nickname });
      room.broadcast('room:state', room.publicState());
      this._startGrace(room, player, config.LOBBY_DISCONNECT_GRACE_MS, true);
      return;
    }

    if (room.state === 'PLAYING') {
      // Oyun DURMAZ — 30sn reconnect penceresi açık kalır (socket detached)
      room.broadcast('room:state', room.publicState());
      this._startGrace(room, player, config.RECONNECT_GRACE_MS, false);
      return;
    }

    if (room.state === 'RESULTS') {
      // Replay hakkı korunur (lastEnd), oda TTL ile GC olur — grace gerekmez
      room.broadcast('room:state', room.publicState());
      return;
    }

    // LOBBY — 60sn grace sonra playerLeft
    room.broadcast('room:state', room.publicState());
    this._startGrace(room, player, config.LOBBY_DISCONNECT_GRACE_MS, false);
  }

  /* ============================================================
   * Grace + oyuncu çıkarma
   * ============================================================ */

  _startGrace(room, player, ms, alreadyNotified) {
    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = setTimeout(() => {
      player.graceTimer = null;
      this._graceExpired(room, player, alreadyNotified);
    }, ms);
  }

  _graceExpired(room, player, alreadyNotified) {
    const p = room.players.get(player.id);
    if (!p || p.connected || p.socket) return; // süre içinde geri döndü
    if (!this.rooms.has(room.code)) return; // oda çoktan kapandı

    if (room.state === 'PLAYING') {
      // Maç devam eder: sadece bildir. Oyuncu kaydı sonuçlar için korunur,
      // end timer maçı normal bitirir ("ikisi de dönmezse timer yine bitirir").
      room.broadcast('room:playerLeft', { nickname: p.nickname });
      return;
    }

    if (room.hostId === p.id) {
      // Host ayrıldı → oda kapanır; kalan oyuncuya haber ver
      for (const other of room.players.values()) {
        if (other.id !== p.id && other.socket) {
          other.socket.emit('room:playerLeft', { nickname: p.nickname });
        }
      }
      this.destroyRoom(room);
      return;
    }

    room.players.delete(p.id);
    this.tokenIndex.delete(p.token);
    if (!alreadyNotified) room.broadcast('room:playerLeft', { nickname: p.nickname });
    room.broadcast('room:state', room.publicState());
    if (room.players.size === 0) this.destroyRoom(room);
  }

  /* ============================================================
   * GC + oda imhası (memory-leak guard)
   * ============================================================ */

  _startGc() {
    this.gcTimer = setInterval(() => this.gc(), config.GC_INTERVAL_MS);
    this.gcTimer.unref?.(); // process'in canlı kalmasını engellemesin
  }

  gc() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.state === 'RESULTS') {
        if (now - (room.resultsAt ?? room.lastActivity) > config.RESULTS_TTL_MS) {
          this.destroyRoom(room);
        }
        continue;
      }
      if (room.state === 'PLAYING') {
        // Güvenlik ağı: end timer herhangi bir nedenle kaçtıysa süreyi zorla bitir
        if (room.endsAt && now > room.endsAt + config.GC_INTERVAL_MS) {
          endGame(room, 'time_up');
        }
        continue;
      }
      // LOBBY + COUNTDOWN — aktivite yoksa yok et
      if (now - room.lastActivity > config.LOBBY_TTL_MS) this.destroyRoom(room);
    }
    // IP deneme kayıtlarını budama
    const windowMs = config.JOIN_RATE_LIMIT.WINDOW_MS;
    for (const [ip, list] of this.joinAttempts) {
      const pruned = list.filter((t) => now - t < windowMs);
      if (pruned.length === 0) this.joinAttempts.delete(ip);
      else this.joinAttempts.set(ip, pruned);
    }
  }

  /** Odayı ve TÜM timer'larını temizle (interval/timeout leak guard). */
  destroyRoom(room) {
    if (!this.rooms.has(room.code)) return;
    this.rooms.delete(room.code);
    for (const t of Object.values(room.timers)) {
      if (t) {
        clearTimeout(t);
        clearInterval(t);
      }
    }
    room.timers = { countdown: null, end: null, timeSync: null, resultsGc: null };
    for (const p of room.players.values()) {
      if (p.graceTimer) {
        clearTimeout(p.graceTimer);
        p.graceTimer = null;
      }
      this.tokenIndex.delete(p.token);
      if (p.socket) this.socketIndex.delete(p.socket.id);
      p.socket = null;
      p.connected = false;
    }
    room.players.clear();
  }

  /** Yöneticiyi kapat (server shutdown / test teardown) — GC interval dahil her şey. */
  close() {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    for (const room of [...this.rooms.values()]) this.destroyRoom(room);
    this.joinAttempts.clear();
  }

  /* ============================================================
   * Dahili yardımcılar
   * ============================================================ */

  _makeRoom(code, host) {
    const manager = this;
    return {
      code,
      state: 'LOBBY',
      createdAt: this.now(),
      lastActivity: this.now(),
      hostId: host.id,
      players: new Map([[host.id, host]]),
      // oyun alanları — game.js doldurur
      letters: null,
      solutions: null,
      endsAt: null,
      lastEnd: null,
      round: 0,
      resultsAt: null,
      timers: { countdown: null, end: null, timeSync: null, resultsGc: null },
      // davranışlar — game.js bu arayüzü kullanır (import döngüsü yok)
      broadcast(event, payload, opts) {
        manager._broadcast(this, event, payload, opts);
      },
      publicState() {
        return publicStateOf(this);
      },
      opponentOf(player) {
        for (const other of this.players.values()) {
          if (other.id !== player.id) return other;
        }
        return null;
      },
      touch() {
        this.lastActivity = manager.now();
      },
      destroy() {
        manager.destroyRoom(this);
      },
    };
  }

  _makePlayer(nickname) {
    return {
      id: randomUUID(),
      nickname,
      token: randomUUID(), // localStorage'da tutulur — reconnect anahtarı
      ready: false,
      score: 0,
      words: [],
      connected: true,
      socket: null,
      graceTimer: null,
      rate: null, // token bucket — game.js allowSubmit lazy-init eder
    };
  }

  _generateRoomCode() {
    const { LENGTH, ALPHABET } = config.ROOM_CODE;
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < LENGTH; i++) {
        code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code; // çakışma → yeni deneme
    }
    throw new Error('Oda kodu üretilemedi (alfabe tükenmesi)');
  }

  _allowJoin(ip) {
    const now = this.now();
    const { MAX, WINDOW_MS } = config.JOIN_RATE_LIMIT;
    const list = (this.joinAttempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= MAX) {
      this.joinAttempts.set(ip, list);
      return false;
    }
    list.push(now);
    this.joinAttempts.set(ip, list);
    return true;
  }

  _attach(socket, room, player) {
    player.socket = socket;
    player.connected = true;
    this.tokenIndex.set(player.token, { roomCode: room.code, playerId: player.id });
    this.socketIndex.set(socket.id, { roomCode: room.code, playerId: player.id });
  }

  _detachSocketIfAttached(socket) {
    const entry = this.socketIndex.get(socket.id);
    if (!entry) return;
    this.socketIndex.delete(socket.id);
    const room = this.rooms.get(entry.roomCode);
    const player = room?.players.get(entry.playerId);
    if (player && player.socket === socket) {
      player.socket = null;
      player.connected = false;
    }
  }

  _resolve(socket) {
    const entry = this.socketIndex.get(socket.id);
    if (!entry) return {};
    const room = this.rooms.get(entry.roomCode);
    const player = room?.players.get(entry.playerId);
    return { room, player };
  }

  _broadcast(room, event, payload, { exclude } = {}) {
    for (const p of room.players.values()) {
      if (p.socket && p.socket !== exclude) p.socket.emit(event, payload);
    }
  }
}
