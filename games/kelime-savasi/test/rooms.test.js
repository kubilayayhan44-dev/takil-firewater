// RoomManager testleri (plan Task 4 + 7 kabul kriterleri).
// Gerçek socket'e ihtiyaç yok — fake socket'ler emit kaydeder; fake timer'larla
// LOBBY expire / grace / GC senaryoları deterministik koşar.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import config from '../server/config.js';
import { RoomManager } from '../server/rooms.js';

/** Kayıt tutan sahte socket: {id, emitted:[{event,payload}], disconnect sayacı}. */
let socketSeq = 0;
function fakeSocket() {
  const s = {
    id: `sock-${++socketSeq}`,
    emitted: [],
    disconnectCount: 0,
    connected: true,
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    disconnect() {
      this.disconnectCount += 1;
      this.connected = false;
    },
  };
  return s;
}

function emitsOf(socket, event) {
  return socket.emitted.filter((e) => e.event === event);
}
function lastEmit(socket, event) {
  const list = emitsOf(socket, event);
  return list[list.length - 1];
}

/** Yaygın kurulum: oda kur + katıl → {manager, room, sockets, acks}. */
function makeFullRoom(nick1 = 'Ayşe', nick2 = 'Mehmet', ip = '10.0.0.1') {
  const manager = new RoomManager();
  const s1 = fakeSocket();
  const s2 = fakeSocket();
  const r1 = manager.createRoom(nick1, s1, ip);
  const r2 = manager.joinRoom(r1.roomCode, nick2, s2, ip);
  expect(r1.ok).toBe(true);
  expect(r2.ok).toBe(true);
  return { manager, s1, s2, r1, r2, room: manager.rooms.get(r1.roomCode) };
}

describe('oda kodu üretimi', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('100 oda kodu çakışmasız üretilir', () => {
    const manager = new RoomManager();
    const codes = new Set();
    for (let i = 0; i < 100; i++) {
      const r = manager.createRoom(`Oyuncu${i}`, fakeSocket(), `10.1.0.${i % 250}`);
      expect(r.ok).toBe(true);
      codes.add(r.roomCode);
    }
    expect(codes.size).toBe(100);
    expect(manager.rooms.size).toBe(100);
  });

  it(`kod ${config.ROOM_CODE.LENGTH} karakter ve belirsiz alfabe (I, L, O, U hariç)`, () => {
    const manager = new RoomManager();
    const alphabet = new Set(config.ROOM_CODE.ALPHABET);
    for (let i = 0; i < 50; i++) {
      const r = manager.createRoom(`Oyuncu${i}`, fakeSocket(), '10.2.0.1');
      expect(r.roomCode).toHaveLength(config.ROOM_CODE.LENGTH);
      for (const ch of r.roomCode) {
        expect(alphabet.has(ch), `bilinmeyen harf: ${ch}`).toBe(true);
      }
      expect(r.roomCode).not.toMatch(/[ILOU]/);
    }
  });
});

describe('createRoom', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ack: {ok, roomCode, playerId, playerToken} + oluşturana room:state', () => {
    const manager = new RoomManager();
    const s = fakeSocket();
    const r = manager.createRoom('Ayşe', s, '10.0.0.1');
    expect(r.ok).toBe(true);
    expect(r.roomCode).toMatch(/^[A-Z]{4}$/);
    expect(r.playerId).toBeTruthy();
    expect(r.playerToken).toBeTruthy();
    expect(r.playerId).not.toBe(r.playerToken);

    const st = lastEmit(s, 'room:state');
    expect(st.payload.state).toBe('LOBBY');
    expect(st.payload.players).toHaveLength(1);
    expect(st.payload.players[0]).toMatchObject({ nickname: 'Ayşe', ready: false, connected: true });
  });

  it('geçersiz takma ad: null / boş / 1 karakter → {ok:false, error:"Geçersiz takma ad"}', () => {
    const manager = new RoomManager();
    for (const bad of [null, '', '  ', 'a', 'x']) {
      const r = manager.createRoom(bad, fakeSocket(), '10.0.0.1');
      expect(r, `nickname: ${JSON.stringify(bad)}`).toEqual({ ok: false, error: 'Geçersiz takma ad' });
    }
  });

  it('uzun takma ad kırpılır (max 16), boşluklar temizlenir', () => {
    const manager = new RoomManager();
    const s = fakeSocket();
    const r = manager.createRoom('  Çok Uzun Bir Takma Ad Buraya  ', s, '10.0.0.1');
    expect(r.ok).toBe(true);
    const st = lastEmit(s, 'room:state');
    expect(st.payload.players[0].nickname).toBe('Çok Uzun Bir Tak'); // 16 karakter
  });

  it('aynı socket ikinci odaya giremez', () => {
    const manager = new RoomManager();
    const s = fakeSocket();
    expect(manager.createRoom('Ayşe', s, '10.0.0.1').ok).toBe(true);
    const again = manager.createRoom('Ayşe', s, '10.0.0.1');
    expect(again).toEqual({ ok: false, error: 'Zaten bir odadasın' });
    expect(manager.rooms.size).toBe(1);
  });
});

describe('joinRoom', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mutlu yol: ack {ok, playerToken, playerId, roomCode, host:{nickname}} + yayınlar', () => {
    const manager = new RoomManager();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    const r1 = manager.createRoom('Ayşe', s1, '10.0.0.1');
    s1.emitted.length = 0; // create yayınlarını ayır

    const r2 = manager.joinRoom(r1.roomCode, 'Mehmet', s2, '10.0.0.2');
    expect(r2.ok).toBe(true);
    expect(r2.roomCode).toBe(r1.roomCode);
    expect(r2.playerToken).toBeTruthy();
    expect(r2.host).toEqual({ nickname: 'Ayşe' });

    // host'a rakip geldi + ikisine de güncel state
    const joined = emitsOf(s1, 'room:playerJoined');
    expect(joined).toHaveLength(1);
    expect(joined[0].payload).toEqual({ nickname: 'Mehmet' });
    const st = lastEmit(s1, 'room:state');
    expect(st.payload.players.map((p) => p.nickname)).toEqual(['Ayşe', 'Mehmet']);
    expect(lastEmit(s2, 'room:state').payload.players).toHaveLength(2);
  });

  it('geçersiz kod formatı → "Kod 4 harfli olmalı" (mock hata stringleriyle aynı)', () => {
    const manager = new RoomManager();
    const r = manager.joinRoom('A1BC', 'Mehmet', fakeSocket(), '10.0.0.1');
    expect(r).toEqual({ ok: false, error: 'Kod 4 harfli olmalı' });
    expect(manager.joinRoom('AB', 'Mehmet', fakeSocket(), '10.0.0.1').error).toBe('Kod 4 harfli olmalı');
  });

  it('olmayan oda → "Oda bulunamadı"', () => {
    const manager = new RoomManager();
    const r = manager.joinRoom('ZZZZ', 'Mehmet', fakeSocket(), '10.0.0.1');
    expect(r).toEqual({ ok: false, error: 'Oda bulunamadı' });
  });

  it('dolu oda (2 kişi) → 3. katılımcı red: "Oda dolu"', () => {
    const { manager, r1 } = makeFullRoom();
    const third = manager.joinRoom(r1.roomCode, 'Zeynep', fakeSocket(), '10.0.0.9');
    expect(third).toEqual({ ok: false, error: 'Oda dolu' });
    const room = manager.rooms.get(r1.roomCode);
    expect(room.players.size).toBe(2);
  });

  it('oyun içindeki (PLAYING) odaya katılım → "Oda müsait değil"', () => {
    const { manager, r1, room } = makeFullRoom();
    room.state = 'PLAYING'; // state machine'i atlat — join guard'ı test ediliyor
    const r = manager.joinRoom(r1.roomCode, 'Zeynep', fakeSocket(), '10.0.0.9');
    expect(r).toEqual({ ok: false, error: 'Oda müsait değil' });
  });
});

describe('join rate-limit — IP başına deneme sınırı', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it(`${config.JOIN_RATE_LIMIT.MAX} deneme/dk üstü → red, pencere geçince tekrar açık`, () => {
    const manager = new RoomManager();
    const host = manager.createRoom('Ayşe', fakeSocket(), '10.0.0.1');

    // 2 başarılı + (MAX-2) "Oda dolu" denemesi = MAX toplam deneme
    let last;
    for (let i = 0; i < config.JOIN_RATE_LIMIT.MAX; i++) {
      last = manager.joinRoom(host.roomCode, `Misafir${i}`, fakeSocket(), '9.9.9.9');
    }
    expect(last.error).toBe('Oda dolu'); // henüz limitte ama oda dolu

    // MAX+1. deneme → limit redti (oda dolu hatasından ÖNCE)
    const blocked = manager.joinRoom(host.roomCode, 'Fazla', fakeSocket(), '9.9.9.9');
    expect(blocked).toEqual({ ok: false, error: 'Çok fazla deneme — biraz bekle' });

    // pencere geçince aynı IP tekrar deneyebilir (oda yine dolu → o hatayı alır)
    vi.advanceTimersByTime(config.JOIN_RATE_LIMIT.WINDOW_MS + 1);
    const after = manager.joinRoom(host.roomCode, 'YeniMisafir', fakeSocket(), '9.9.9.9');
    expect(after.ok).toBe(false);
    expect(after.error).toBe('Oda dolu');
  });

  it("farklı IP'ler birbirini etkilemez", () => {
    const manager = new RoomManager();
    const host = manager.createRoom('Ayşe', fakeSocket(), '10.0.0.1');
    for (let i = 0; i < config.JOIN_RATE_LIMIT.MAX; i++) {
      manager.joinRoom(host.roomCode, `M${i}`, fakeSocket(), '9.9.9.9'); // IP A tükendi
    }
    const otherIp = manager.joinRoom(host.roomCode, 'TemizIp', fakeSocket(), '8.8.8.8');
    expect(otherIp.ok).toBe(false);
    expect(otherIp.error).toBe('Oda dolu'); // limit değil — oda gerçekten dolu
  });
});

describe('reconnectByToken', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('bilinmeyen/geçersiz token → {ok:false, error:"Oda bulunamadı"}', () => {
    const manager = new RoomManager();
    expect(manager.reconnectByToken('yok-boyle-token', fakeSocket())).toEqual({
      ok: false,
      error: 'Oda bulunamadı',
    });
    expect(manager.reconnectByToken(null, fakeSocket()).ok).toBe(false);
  });

  it('PLAYING\'de tam state replay: harfler/skor/kelimeler/süre korunur', () => {
    const { manager, s1, s2, r1, r2, room } = makeFullRoom();

    // oyun ortası state'i kur (state machine'i atlatmadan elle)
    room.state = 'PLAYING';
    room.letters = ['e', 'l', 'm', 'a', 'k', 't'];
    room.endsAt = Date.now() + 60_000;
    const p1 = room.players.get(r1.playerId);
    p1.score = 35;
    p1.words = [
      { word: 'kale', points: 25 },
      { word: 'elma', points: 10 },
    ];
    const p2 = room.players.get(r2.playerId);
    p2.score = 10;
    p2.words = [{ word: 'elma', points: 10 }];

    // misafir koptu → grace penceresi
    manager.handleDisconnect(s2);

    // host connected:false state'i gördü
    const st = lastEmit([...room.players.values()].find((p) => p.id === r1.playerId).socket, 'room:state');
    expect(st.payload.state).toBe('PLAYING'); // oyun DURMADI
    expect(st.payload.players.find((p) => p.id === r2.playerId).connected).toBe(false);

    // yeni socket ile reconnect
    const s2b = fakeSocket();
    const replay = manager.reconnectByToken(r2.playerToken, s2b);
    expect(replay.ok).toBe(true);
    expect(replay.state).toBe('PLAYING');
    expect(replay.code).toBe(room.code);
    expect(replay.letters).toEqual(room.letters);
    expect(replay.endsAt).toBe(room.endsAt);
    expect(replay.you.score).toBe(10);
    expect(replay.you.words).toEqual([{ word: 'elma', points: 10 }]);
    expect(replay.opponent.nickname).toBe('Ayşe');
    expect(replay.opponent.score).toBe(35);
    expect(replay.lastEnd).toBeNull();
  });

  it('tek socket kuralı: yeni bağlantı eski socket\'i düşürür', () => {
    const { manager, r2, room } = makeFullRoom();
    const guest = room.players.get(r2.playerId);
    const oldSocket = guest.socket;
    expect(oldSocket.disconnectCount).toBe(0);

    const s2b = fakeSocket();
    const replay = manager.reconnectByToken(r2.playerToken, s2b);
    expect(replay.ok).toBe(true);
    expect(guest.socket).toBe(s2b); // yeni socket bağlı
    expect(oldSocket.disconnectCount).toBe(1); // eski düşürüldü
    expect(manager.socketIndex.has(oldSocket.id)).toBe(false);
    expect(manager.socketIndex.has(s2b.id)).toBe(true);
  });

  it('reconnect sonrası grace iptal — LOBBY\'de kalan oyuncu geri döner', () => {
    const { manager, r2, room } = makeFullRoom();
    const guest = room.players.get(r2.playerId);
    const oldSocket = guest.socket;
    manager.handleDisconnect(oldSocket);

    vi.advanceTimersByTime(config.LOBBY_DISCONNECT_GRACE_MS - 1_000); // grace bitmeden
    const s2b = fakeSocket();
    expect(manager.reconnectByToken(r2.playerToken, s2b).ok).toBe(true);

    vi.advanceTimersByTime(2_000); // eski grace süresi dolardı
    expect(room.players.has(r2.playerId)).toBe(true); // hâlâ odada
    expect(guest.connected).toBe(true);
  });
});

describe('disconnect grace + GC (plan Task 7)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('LOBBY\'de disconnect → 60sn grace → playerLeft (oyuncu odadan düşer)', () => {
    const { manager, s2, r1, r2, room } = makeFullRoom();
    const hostSocket = room.players.get(r1.playerId).socket;

    manager.handleDisconnect(s2);
    vi.advanceTimersByTime(config.LOBBY_DISCONNECT_GRACE_MS - 1);
    expect(room.players.has(r2.playerId)).toBe(true); // grace içinde duruyor

    vi.advanceTimersByTime(2);
    expect(room.players.has(r2.playerId)).toBe(false); // düştü

    const left = lastEmit(hostSocket, 'room:playerLeft');
    expect(left.payload).toEqual({ nickname: 'Mehmet' });
    const st = lastEmit(hostSocket, 'room:state');
    expect(st.payload.players.map((p) => p.nickname)).toEqual(['Ayşe']);
    expect(manager.rooms.size).toBe(1); // host beklemeye devam
  });

  it('host ayrılırsa oda KAPANIR — kalan oyuncuya playerLeft + oda yok olur', () => {
    const { manager, s1, room } = makeFullRoom();
    const guestSocket = [...room.players.values()].find((p) => p.id !== room.hostId).socket;

    manager.handleDisconnect(s1); // host koptu
    vi.advanceTimersByTime(config.LOBBY_DISCONNECT_GRACE_MS + 1);

    const left = lastEmit(guestSocket, 'room:playerLeft');
    expect(left.payload).toEqual({ nickname: 'Ayşe' });
    expect(manager.rooms.size).toBe(0); // oda kapandı
    expect(guestSocket.disconnectCount).toBe(0); // guest socket'i düşürülmedi, sadece oda gitti
  });

  it('PLAYING\'de disconnect → oyun DURMAZ; 30sn sonra playerLeft ama oda yaşar', () => {
    const { manager, s2, r1, r2, room } = makeFullRoom();
    room.state = 'PLAYING';
    room.endsAt = Date.now() + 90_000;
    const hostSocket = room.players.get(r1.playerId).socket;

    manager.handleDisconnect(s2);
    expect(room.state).toBe('PLAYING'); // oyun devam
    vi.advanceTimersByTime(config.RECONNECT_GRACE_MS - 1);
    expect(room.players.has(r2.playerId)).toBe(true); // grace içinde oyuncu kaydı duruyor

    vi.advanceTimersByTime(2); // grace doldu
    expect(room.state).toBe('PLAYING'); // maç hâlâ ayakta
    expect(lastEmit(hostSocket, 'room:playerLeft').payload).toEqual({ nickname: 'Mehmet' });
    expect(manager.rooms.size).toBe(1);
  });

  it('PLAYING grace dolsa da reconnect yine kabul (maç bitmeden dönüş)', () => {
    const { manager, s2, r2, room } = makeFullRoom();
    room.state = 'PLAYING';
    room.endsAt = Date.now() + 90_000;

    manager.handleDisconnect(s2);
    vi.advanceTimersByTime(config.RECONNECT_GRACE_MS + 1_000); // playerLeft bildirildi
    const s2b = fakeSocket();
    expect(manager.reconnectByToken(r2.playerToken, s2b).ok).toBe(true); // affedici dönüş
    expect(room.players.get(r2.playerId).connected).toBe(true);
  });

  it('LOBBY expire: 10dk aktivite yoksa GC ile oda silinir', () => {
    const manager = new RoomManager();
    const s = fakeSocket();
    const r = manager.createRoom('Yalnız', s, '10.0.0.1');
    const room = manager.rooms.get(r.roomCode);
    expect(room).toBeTruthy();

    vi.advanceTimersByTime(config.LOBBY_TTL_MS + config.GC_INTERVAL_MS + 100);
    expect(manager.rooms.size).toBe(0);
  });

  it('GC sonrası oda timer\'ları tamamen temiz (memory-leak guard)', () => {
    const { manager, room } = makeFullRoom();
    // sahte timer'lar yerleştir — destroy hepsini clear etmeli
    room.timers.countdown = setTimeout(() => {}, 60_000);
    room.timers.end = setTimeout(() => {}, 60_000);
    room.timers.timeSync = setInterval(() => {}, 1_000);
    room.timers.resultsGc = setTimeout(() => {}, 60_000);
    for (const p of room.players.values()) {
      p.graceTimer = setTimeout(() => {}, 60_000);
    }

    vi.advanceTimersByTime(config.LOBBY_TTL_MS + config.GC_INTERVAL_MS + 100);
    expect(manager.rooms.size).toBe(0);
    expect(Object.values(room.timers).every((t) => t === null)).toBe(true);
    for (const p of room.players.values()) {
      expect(p.graceTimer).toBeNull();
    }
    // artık ileri sarınca HİÇBİR eski timer tetiklenmemeli (fake timer kuyruğu boş kalır)
    vi.advanceTimersByTime(120_000);
    expect(manager.rooms.size).toBe(0);
  });

  it('manager.close() odaları temizler + GC interval durur (sonradan oda expire olmaz)', () => {
    const manager = new RoomManager();
    manager.createRoom('Yalnız', fakeSocket(), '10.0.0.1');
    expect(manager.rooms.size).toBe(1);

    manager.close();
    expect(manager.rooms.size).toBe(0); // shutdown: tüm odalar anında temizlendi
    expect(manager.gcTimer).toBeNull(); // interval durdu

    // close sonrası açılan oda artık GC tarafından expire EDİLMEZ (interval öldü)
    manager.createRoom('Sonra', fakeSocket(), '10.0.0.2');
    vi.advanceTimersByTime(config.LOBBY_TTL_MS + config.GC_INTERVAL_MS * 3);
    expect(manager.rooms.size).toBe(1); // GC koşmadı
  });

  it('aktivite LOBBY ömrünü uzatır (touch)', () => {
    const manager = new RoomManager();
    const s = fakeSocket();
    const r = manager.createRoom('Yalnız', s, '10.0.0.1');

    vi.advanceTimersByTime(config.LOBBY_TTL_MS / 2);
    manager.setReady(s, true); // aktivite → lastActivity tazelendi
    vi.advanceTimersByTime(config.LOBBY_TTL_MS + config.GC_INTERVAL_MS - 1_000);
    expect(manager.rooms.size).toBe(1); // henüz ölmedi
    vi.advanceTimersByTime(config.GC_INTERVAL_MS + 2_000);
    expect(manager.rooms.size).toBe(0);
  });
});
