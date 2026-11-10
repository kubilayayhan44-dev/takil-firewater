#!/usr/bin/env node
// Kelime Savaşı — Faz 2 manuel SMOKE testi.
// Kendi server instance'ını kısa sürelerle spawn eder, 2 sahte oyuncu ile
// tam akış koşturur: health → create → join → ready → countdown → start →
// kelime submit (kabul/red/duplicate/aynı kelime) → PLAYING disconnect →
// reconnect replay → game:end (winner + çözüm listesi).
//
// Kullanım: node scripts/smoke.mjs   (bağımlılık: sadece node_modules — sunucu KENDİ spawn'ı)
// Çıkış: 0 = SMOKE OK, 1 = SMOKE FAIL.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { io } from 'socket.io-client';
import config from '../server/config.js';
import { loadDictionary, solutionsForLetters } from '../server/dictionary.js';
import { wordPoints } from '../server/scoring.js';

const PORT = 8791; // test amaçlı — 8765 (Takıl) ve 8766 (prod) ile çakışmaz
const BASE = config.BASE_PATH;
const URL = `http://127.0.0.1:${PORT}`;
const GAME_MS = 8_000;
const COUNTDOWN_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function emitAck(c, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 8_000);
    c.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

function assert(cond, label) {
  if (!cond) throw new Error(`SMOKE assertion: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${URL}${BASE}/api/health`);
      if (res.status === 200) {
        const body = await res.json();
        assert(body.ok === true && body.dict === true, `health 200 (dict: ${body.dict})`);
        return;
      }
    } catch { /* henüz ayakta değil */ }
    await sleep(200);
  }
  throw new Error('health check 12 sn içinde 200 dönmedi');
}

async function main() {
  loadDictionary(); // kelime seçimi için (server ile aynı data/ sözlüğü)

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      GAME_DURATION_MS: String(GAME_MS),
      COUNTDOWN_MS: String(COUNTDOWN_MS),
      TIME_SYNC_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));

  let p1, p2;
  try {
    console.log('— health —');
    await waitHealthy();

    console.log('— oda kur / katıl —');
    p1 = io(URL, { path: `${BASE}/socket.io`, transports: ['websocket'], reconnection: false });
    p2 = io(URL, { path: `${BASE}/socket.io`, transports: ['websocket'], reconnection: false });
    await Promise.all([once(p1, 'connect'), once(p2, 'connect')]);

    const r1 = await emitAck(p1, 'room:create', { nickname: 'Duman' });
    assert(r1.ok === true, `oda kuruldu: ${r1.roomCode} (token: ${r1.playerToken.slice(0, 8)}…)`);

    const joinSeen = once(p1, 'room:playerJoined');
    const r2 = await emitAck(p2, 'room:join', { roomCode: r1.roomCode, nickname: 'Rüzgar' });
    assert(r2.ok === true && r2.host.nickname === 'Duman', `katılım ok — host: ${r2.host.nickname}`);
    assert((await joinSeen).nickname === 'Rüzgar', 'host playerJoined aldı');

    console.log('— hazır → geri sayım → başlangıç —');
    const cd1 = once(p1, 'game:countdown');
    const cd2 = once(p2, 'game:countdown');
    const st1 = once(p1, 'game:start');
    const st2 = once(p2, 'game:start');
    assert((await emitAck(p1, 'game:ready', { ready: true })).ok === true, 'Duman hazır');
    assert((await emitAck(p2, 'game:ready', { ready: true })).ok === true, 'Rüzgar hazır');
    await Promise.all([cd1, cd2]);
    const [s1, s2] = await Promise.all([st1, st2]);
    assert(
      JSON.stringify(s1.letters) === JSON.stringify(s2.letters) && s1.endsAt === s2.endsAt,
      `harfler iki oyuncuya AYNI: ${s1.letters.join('')}`,
    );

    console.log('— kelime akışı —');
    const solutions = solutionsForLetters(s1.letters);
    const w3 = solutions.find((w) => w.length === 3);
    const w4 = solutions.find((w) => w.length === 4);
    const w5 = solutions.find((w) => w.length === 5);

    const accA = once(p1, 'word:accepted');
    const a1 = await emitAck(p1, 'word:submit', { word: w3 });
    assert(a1.ok === true && a1.points === wordPoints(w3), `'${w3}' kabul: +${a1.points} (toplam ${a1.totalScore})`);
    assert((await accA).word === w3, "oda broadcast 'word:accepted' aldı");

    const dup = await emitAck(p1, 'word:submit', { word: w3 });
    assert(dup.ok === false && dup.reason === 'duplicate', `tekrar '${w3}' → duplicate`);

    const invalid = await emitAck(p1, 'word:submit', { word: 'zzzzzz' });
    assert(invalid.ok === false && !!invalid.reason, `geçersiz kelime red — reason: ${invalid.reason}`);

    const same = await emitAck(p2, 'word:submit', { word: w3 });
    assert(same.ok === true && same.totalScore === wordPoints(w3), `rakip aynı kelimeyi buldu → ikisi de puan aldı`);

    if (w4) {
      const r = await emitAck(p1, 'word:submit', { word: w4 });
      assert(r.ok === true, `'${w4}' kabul: +${r.points} (toplam ${r.totalScore})`);
    }
    if (w5) {
      const r = await emitAck(p1, 'word:submit', { word: w5 });
      assert(r.ok === true, `'${w5}' kabul: +${r.points} (toplam ${r.totalScore})`);
    }

    console.log('— PLAYING disconnect → reconnect replay —');
    p2.disconnect();
    const sawDown = once(p1, 'room:state', {
      filter: (st) => st.state === 'PLAYING' &&
        st.players.find((p) => p.nickname === 'Rüzgar')?.connected === false,
    });
    await sawDown;
    assert(true, 'oyun DURMADI — host disconnected görüyor');

    const p2b = io(URL, { path: `${BASE}/socket.io`, transports: ['websocket'], reconnection: false });
    await once(p2b, 'connect');
    const replay = await emitAck(p2b, 'room:reconnect', { playerToken: r2.playerToken });
    assert(replay.ok === true && replay.state === 'PLAYING', 'token reconnect → PLAYING replay');
    assert(
      replay.letters.join('') === s1.letters.join('') &&
        replay.you.score === wordPoints(w3) &&
        replay.you.words.length === 1,
      `replay: skor ${replay.you.score}, kelimeler korundu`,
    );

    console.log('— maç sonu —');
    const [e1, e2] = await Promise.all([
      once(p1, 'game:end', { timeout: 15_000 }),
      once(p2b, 'game:end', { timeout: 15_000 }),
    ]);
    assert(e1.reason === 'time_up' && e2.reason === 'time_up', 'her iki oyuncu game:end (time_up) aldı');
    assert(
      e1.winner === e2.winner && e1.solutionList.length === solutions.length,
      `winner: ${e1.winner === 'tie' ? 'BERABERE' : e1.winnerNickname} — çözüm listesi: ${e1.solutionList.length} kelime`,
    );
    for (const r of e1.results) {
      console.log(`    ${r.nickname}: ${r.score} puan, ${r.words.length} kelime (${r.longWords} uzun)`);
    }
  } finally {
    try { p1?.disconnect(); } catch { /* yoksay */ }
    try { p2?.disconnect(); } catch { /* yoksay */ }
    child.kill('SIGTERM');
    await sleep(400);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

main()
  .then(() => {
    console.log('\nSMOKE OK ✅');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nSMOKE FAIL ❌:', err.message || err);
    process.exit(1);
  });
