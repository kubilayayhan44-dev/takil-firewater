// Kelime Savaşı server bootstrap — Express (static + health) + Socket.IO (rooms + game).
//
// Faz 2: gerçek event handler'lar (rooms.js + game.js) buraya bağlanır.
// Test edilebilirlik: createApp() HTTP+IO+manager döndürür (entegrasyon testleri
// ephemeral portta ayağa kaldırır); `npm start` main bloğundan dinlemeye başlar.
//
// Socket event sözleşmesi (public/js/net.js SocketNet + mock ile birebir):
//   Client → Server (ack):  room:create, room:join, room:reconnect, game:ready,
//                           word:submit, game:rematch
//   Server → Client:        room:state, room:playerJoined, room:playerLeft,
//                           game:countdown, game:start, game:timeSync, game:end,
//                           word:accepted, game:rematch, error

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import config from './config.js';
import { loadDictionary, isReady } from './dictionary.js';
import { RoomManager } from './rooms.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Uygulamayı kurar (dinlemeden). Entegrasyon testleri ve ana giriş aynı yolu kullanır.
 * @param {{manager?: RoomManager, loadDictionary?: boolean}} opts
 */
export function createApp(opts = {}) {
  const app = express();
  app.disable('x-powered-by');

  // --- Sözlük boot — dosya yoksa da server ayağa kalkar (health yaşar) ---
  if (opts.loadDictionary !== false) {
    try {
      const { count } = loadDictionary();
      console.log(`[boot] sözlük yüklendi: ${count} kelime`);
    } catch (err) {
      console.warn(`[boot] sözlük yüklenemedi (${err.message}) — word:submit devre dışı kalacak`);
    }
  }

  // --- Static: public/ → BASE_PATH altında ---
  app.use(config.BASE_PATH, express.static(path.join(ROOT, 'public')));

  // --- Health (Caddy/systemd liveness) ---
  app.get(`${config.BASE_PATH}/api/health`, (_req, res) => {
    res.json({ ok: true, uptime: Math.floor(process.uptime()), dict: isReady() });
  });

  // --- Bilinmeyen API yolları → JSON 404 ---
  app.use(`${config.BASE_PATH}/api`, (_req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // --- Socket.IO (oyun kanalı) ---
  const server = http.createServer(app);
  const io = new Server(server, {
    path: `${config.BASE_PATH}/socket.io`,
    cors: {
      origin: config.CORS_ORIGINS, // dev: Takıl (localhost:8765) sayfasından bağlantı
      methods: ['GET', 'POST'],
    },
  });

  const manager = opts.manager ?? new RoomManager();

  const reply = (ack, payload) => {
    if (typeof ack === 'function') ack(payload);
  };
  const guard = (ack, fn) => {
    try {
      reply(ack, fn());
    } catch (err) {
      console.error('[socket] handler hatası:', err);
      reply(ack, { ok: false, error: 'Sunucu hatası' });
    }
  };

  io.on('connection', (socket) => {
    const ip = socket.handshake.address ?? 'unknown';

    // Handshake auth: playerToken geldiyse otomatik reconnect dene.
    // (UI Faz 2 stub'ı auth göndermese de room:reconnect event'i aynı işi yapar.)
    const authToken = socket.handshake.auth?.playerToken;
    if (typeof authToken === 'string' && authToken) {
      try {
        manager.reconnectByToken(authToken, socket);
      } catch (err) {
        console.error('[socket] auth reconnect hatası:', err);
      }
    }

    socket.on('room:create', (p, ack) => guard(ack, () => manager.createRoom(p?.nickname, socket, ip)));
    socket.on('room:join', (p, ack) => guard(ack, () => manager.joinRoom(p?.roomCode, p?.nickname, socket, ip)));
    socket.on('room:reconnect', (p, ack) => guard(ack, () => manager.reconnectByToken(p?.playerToken, socket)));
    socket.on('game:ready', (p, ack) => guard(ack, () => manager.setReady(socket, !!p?.ready)));
    socket.on('word:submit', (p, ack) => guard(ack, () => manager.submitWord(socket, p?.word)));
    socket.on('game:rematch', (_p, ack) => guard(ack, () => manager.rematch(socket)));

    socket.on('disconnect', () => manager.handleDisconnect(socket));
  });

  return { app, server, io, manager };
}

// --- Doğrudan çalıştırma (npm start / systemd unit) ---
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { server, io, manager } = createApp();
  server.listen(config.PORT, config.HOST, () => {
    console.log(`[boot] Kelime Savaşı → http://${config.HOST}:${config.PORT}${config.BASE_PATH}`);
  });

  // Graceful shutdown (systemd stop / Ctrl+C)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`[boot] ${sig} alındı — kapatılıyor`);
      manager.close(); // tüm oda timer'ları + GC interval temizlenir
      io.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  }
}
