// Kelime Savaşı — tüm sabitler TEK NOKTADAN.
// Kural: başka modülde sabit string/number tanımlamak YASAK, her şey buradan import edilir
// (plan Task 1 risk notu: BASE_PATH her yerde tutarlı olmalı).

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export default {
  // --- HTTP / Socket.IO ---
  PORT: num(process.env.PORT, 8766),
  HOST: process.env.HOST || '127.0.0.1',
  BASE_PATH: (process.env.BASE_PATH || '/games/kelime-savasi').replace(/\/+$/, '') || '/',

  // --- Oyun akışı (Faz 2 game.js tüketecek) ---
  GAME_DURATION_MS: num(process.env.GAME_DURATION_MS, 90_000),
  COUNTDOWN_MS: num(process.env.COUNTDOWN_MS, 3_000),
  RECONNECT_GRACE_MS: 30_000,
  RESULTS_TTL_MS: 120_000,
  LOBBY_TTL_MS: 10 * 60_000,
  GC_INTERVAL_MS: 30_000,

  // --- word:submit rate limit (oyuncu başına token bucket) ---
  RATE_LIMIT: {
    MAX_WORDS: 12, // pencere başına üst sınır (üstü sessizce düşer)
    WINDOW_MS: 5_000,
  },

  // --- Faz 2: oda kodu + oda akışı + puanlama (plan Task 4/5/6) ---
  ROOM_CODE: {
    LENGTH: 4,
    ALPHABET: 'ABCDEFGHJKMNPQRSTVWXYZ', // I, L, O, U hariç — belirsizlik yok
  },
  NICKNAME: { MIN_LEN: 2, MAX_LEN: 16 },
  JOIN_RATE_LIMIT: { MAX: 10, WINDOW_MS: 60_000 }, // IP başına odaya katılma denemesi
  TIME_SYNC_INTERVAL_MS: num(process.env.TIME_SYNC_INTERVAL_MS, 5_000),
  LOBBY_DISCONNECT_GRACE_MS: 60_000, // LOBBY'de disconnect → bu kadar sonra playerLeft
  SCORING: {
    POINTS: { 3: 10, 4: 25, 5: 50, 6: 100 }, // kelime uzunluğu → puan (plan Task 6)
  },

  // --- Kelime kuralları ---
  WORD: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 6, // v1 harf çarkı 6 harf
  },

  // --- Puzzle kabul kriterleri (generate + gen-puzzles ortak) ---
  PUZZLE: {
    LETTER_COUNT: 6,
    MIN_SOLUTIONS: 15,
    MAX_SOLUTIONS: 80,
    MIN_LONG_WORDS: 2, // ≥5 harfli kelime alt sınırı
    LONG_WORD_MIN_LEN: 5,
    MIN_VOWELS: 2, // 6 harfin 2-4'ü sesli olmalı (a e ı i o ö u ü)
    MAX_VOWELS: 4,
    MAX_ATTEMPTS: 60, // ret döngüsü tavanı — sonrasında hata (havuz fallback devreye girer)
    POOL_SIZE: 150, // gen-puzzles.mjs hedef havuz boyutu
  },

  // --- Dosya yolları (paket köküne göre — server/ ve scripts/ kendi kök çözümlemesi yapar) ---
  PATHS: {
    WORDS: 'data/words.tr.json',
    PUZZLES: 'data/puzzles.json',
    RAW_DIC_CACHE: 'data/raw/tr_TR.dic',
  },

  // --- Socket.IO CORS ---
  // Prod: Takıl ana site — sayfa Caddy arkasından AYNI origin'de servis edilir ve
  // socket.io handshake'i tarayıcıdan Origin header'ıyla gelir. Polling fallback
  // (mobil operatör ağında WS engelli senaryo) için whitelist'te OLMALI, yoksa
  // Access-Control-Allow-Origin dönmez ve long-polling XHR tarayıcıda reddedilir.
  // :3210 block'u Caddyfile'da mevcut (tls cert'li) — o origin'den de açılır.
  // Dev: Takıl dev-server (8765) sayfasından bağlanmak için.
  // Ekstra: CORS_ORIGINS env (virgülle ayrılmış) — yeni domain eklemek için yeniden build gerekmez.
  CORS_ORIGINS: [
    ...(process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : []),
    'https://178-105-90-130.nip.io',
    'http://178-105-90-130.nip.io:3210',
    'https://178-105-90-130.nip.io:3210',
    'http://178-105-90-130.nip.io',
    'http://localhost:8765',
    'http://127.0.0.1:8765',
  ],
};
