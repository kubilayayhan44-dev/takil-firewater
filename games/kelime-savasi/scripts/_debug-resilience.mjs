// Geçici debug 2 — vitest testinin TAM aynısı (valid submit + filter'lı once)
import { io } from 'socket.io-client';
import config from '../server/config.js';
import { createApp } from '../server/index.js';
import { solutionsForLetters } from '../server/dictionary.js';

config.COUNTDOWN_MS = 400;
config.GAME_DURATION_MS = 2500;
config.TIME_SYNC_INTERVAL_MS = 350;

const once = (c, ev, { filter, timeout = 5000 } = {}) => new Promise((res, rej) => {
  const on = (p) => { if (filter && !filter(p)) return; c.off(ev, on); clearTimeout(t); res(p); };
  const t = setTimeout(() => { c.off(ev, on); rej(new Error(`timeout ${ev}`)); }, timeout);
  c.on(ev, on);
});
const ack = (c, ev, p) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`ack timeout ${ev}`)), 5000);
  c.emit(ev, p, (r) => { clearTimeout(t); res(r); });
});

const app = createApp();
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${app.server.address().port}`;

try {
  const p5 = io(URL, { path: `${config.BASE_PATH}/socket.io`, transports: ['websocket'], forceNew: true, reconnection: false });
  const p6 = io(URL, { path: `${config.BASE_PATH}/socket.io`, transports: ['websocket'], forceNew: true, reconnection: false });
  await Promise.all([once(p5, 'connect'), once(p6, 'connect')]);

  const r5 = await ack(p5, 'room:create', { nickname: 'Kemal' });
  const r6 = await ack(p6, 'room:join', { roomCode: r5.roomCode, nickname: 'Zeynep' });
  console.log('join ok:', r6.ok);

  const st5 = once(p5, 'game:start');
  const st6 = once(p6, 'game:start');
  await ack(p5, 'game:ready', { ready: true });
  await ack(p6, 'game:ready', { ready: true });
  const [s5, s6] = await Promise.all([st5, st6]);

  const w = solutionsForLetters(s5.letters).find((x) => x.length === 4);
  const got = await ack(p6, 'word:submit', { word: w });
  console.log('submit:', JSON.stringify(got));
  if (!got.ok) throw new Error('submit beklenmedik red: ' + JSON.stringify(got));

  const sawDown = once(p5, 'room:state', {
    filter: (st) => st.state === 'PLAYING' &&
      st.players.find((p) => p.id === r6.playerId)?.connected === false,
  });
  p6.disconnect();
  const down = await sawDown;
  console.log('SAWDOWN OK:', JSON.stringify(down.players.map((p) => ({ n: p.nickname, c: p.connected }))));

  const p6b = io(URL, { path: `${config.BASE_PATH}/socket.io`, transports: ['websocket'], forceNew: true, reconnection: false });
  await once(p6b, 'connect');
  const replay = await ack(p6b, 'room:reconnect', { playerToken: r6.playerToken });
  console.log('REPLAY OK:', replay.ok, replay.state, 'score:', replay.you.score);
  console.log('DEBUG SCRIPT: TÜM ADIMLAR GEÇTİ ✅');
} finally {
  app.manager.close();
  await new Promise((r) => app.server.close(r));
  setTimeout(() => process.exit(0), 200);
}
