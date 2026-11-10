/**
 * Kelime Savaşı — main.js
 * Uygulama omurgası: ekran yönetimi, ses sentezi (WebAudio), efektler,
 * depolama (localStorage), KSNet olaylarının UI'ya bağlanması,
 * geri sayım, reconnect rebuild, rematch.
 */

'use strict';

import KSNet from './net.js';
import { initLobby, avatarFor } from './ui/lobby.js';
import { initGameScreen } from './ui/game-screen.js';
import { initResults } from './ui/results.js';

/* ============================================================
 * Depolama
 * ============================================================ */
const LS = {
  get nickname() { return localStorage.getItem('ks_nickname') || ''; },
  set nickname(v) { localStorage.setItem('ks_nickname', v); },
  get token() { return localStorage.getItem('ks_playerToken') || ''; },
  set token(v) { localStorage.setItem('ks_playerToken', v); },
  clearToken() { localStorage.removeItem('ks_playerToken'); },
  get muted() { return localStorage.getItem('ks_muted') === '1'; },
  set muted(v) { localStorage.setItem('ks_muted', v ? '1' : '0'); },
};

/**
 * Sekme sahipliği: localStorage ortak olduğundan, başka sekmenin token'ıyla
 * otomatik reconnect yapmamak için kendi token'ımızı sessionStorage'a da yazarız.
 */
function saveToken(token) {
  LS.token = token;
  try { sessionStorage.setItem('ks_ownToken', token); } catch { /* yoksay */ }
}
function ownToken() {
  try {
    const own = sessionStorage.getItem('ks_ownToken');
    return own && own === LS.token ? own : null;
  } catch { return LS.token; }
}

/* ============================================================
 * Ekran yöneticisi
 * ============================================================ */
const screens = {
  current: null,
  show(id) {
    const next = document.getElementById(id);
    if (!next || next === this.current) return;
    // HTML'den gelen ilk .active dahil TÜM aktifleri temizle
    // (ilk show'da this.current null'dur — nickname ekranı kalsın istemiyorsak bu şart)
    document.querySelectorAll('.screen.active').forEach((s) => {
      if (s !== next) s.classList.remove('active');
    });
    next.classList.add('active');
    this.current = next;
    next.scrollTop = 0;
  },
  isActive(id) { return this.current?.id === id; },
};

/* ============================================================
 * Ses — WebAudio ile sentez (dosya yok)
 * ============================================================ */
const Sound = {
  ctx: null,
  muted: LS.muted,

  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* yoksay */ }
  },

  /** Temel ton: osilatör + zarf */
  tone({ freq = 440, dur = 0.15, type = 'sine', gain = 0.16, when = 0, slideTo = null }) {
    if (this.muted || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime + when;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch { /* yoksay */ }
  },

  /** Harf seçimi: pentatonik yükselen kısa tık */
  letter(count = 1) {
    const scale = [392, 440, 494, 587, 659, 740];
    const f = scale[(count - 1) % scale.length] * (count > 6 ? 2 : 1);
    this.tone({ freq: f, dur: 0.07, type: 'triangle', gain: 0.12 });
  },

  /** Kelime kabul: çan arpej (uzun kelime → daha zengin) */
  accept(len = 3) {
    const base = [523.25, 659.25, 783.99];
    if (len >= 5) base.push(1046.5);
    if (len >= 6) base.push(1318.5);
    base.forEach((f, i) => {
      this.tone({ freq: f, dur: 0.28, type: 'sine', gain: 0.14, when: i * 0.055 });
      this.tone({ freq: f * 2, dur: 0.18, type: 'triangle', gain: 0.05, when: i * 0.055 });
    });
  },

  /** Ret: düşük buzz */
  reject() {
    this.tone({ freq: 150, dur: 0.18, type: 'square', gain: 0.1, slideTo: 92 });
  },

  /** Geri sayım tık */
  tick() { this.tone({ freq: 660, dur: 0.07, type: 'sine', gain: 0.12 }); },

  /** BAŞLA! */
  go() {
    this.tone({ freq: 880, dur: 0.16, type: 'triangle', gain: 0.16 });
    this.tone({ freq: 1174, dur: 0.2, type: 'triangle', gain: 0.12, when: 0.08 });
  },

  /** Son 5 sn tıkları */
  tickLow() { this.tone({ freq: 440, dur: 0.05, type: 'sine', gain: 0.07 }); },

  /** Rakip kelime buldu (soluk bildirim) */
  foeFound() { this.tone({ freq: 494, dur: 0.1, type: 'sine', gain: 0.06 }); },

  /** Kazanan fanfarı */
  win() {
    const seq = [[392, 0], [523.25, 0.12], [659.25, 0.24], [783.99, 0.36], [1046.5, 0.52]];
    seq.forEach(([f, t]) => this.tone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.15, when: t }));
    // final akoru
    [523.25, 659.25, 783.99].forEach((f) =>
      this.tone({ freq: f, dur: 0.7, type: 'sine', gain: 0.09, when: 0.72 }));
  },

  /** Kaybetti — yumuşak minör iniş */
  lose() {
    this.tone({ freq: 392, dur: 0.3, type: 'sine', gain: 0.12 });
    this.tone({ freq: 311, dur: 0.35, type: 'sine', gain: 0.1, when: 0.18 });
    this.tone({ freq: 261, dur: 0.5, type: 'sine', gain: 0.1, when: 0.36 });
  },

  toggle() {
    this.muted = !this.muted;
    LS.muted = this.muted;
    return this.muted;
  },
};

// İlk pointer'da AudioContext kilidini aç (mobil autoplay politikası)
document.addEventListener('pointerdown', () => Sound.unlock(), { capture: true });

/* ============================================================
 * FX — parıltı patlaması + puan uçuşu (transform/opacity)
 * ============================================================ */
const fxLayer = document.getElementById('fx-layer');

const fx = {
  burst(x, y, { count = 12, color = '' } = {}) {
    // mobil perf tavanı: katmanda en fazla ~60 parçacık
    if (fxLayer.childElementCount > 60) return;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = `particle ${color}`;
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
      const dist = 44 + Math.random() * 56;
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
      p.style.setProperty('--rot', `${Math.round(Math.random() * 240 - 120)}deg`);
      fxLayer.appendChild(p);
      setTimeout(() => p.remove(), 700);
    }
  },

  floatText(x, y, text, { bad = false } = {}) {
    const el = document.createElement('span');
    el.className = `float-score ${bad ? 'fs-bad' : ''}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 1050);
  },
};

/* ============================================================
 * Toast
 * ============================================================ */
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(message, kind = '') {
  toastEl.textContent = message;
  toastEl.className = `show ${kind === 'bad' ? 'toast-bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 1900);
}

/* ============================================================
 * Uygulama durumu
 * ============================================================ */
const state = {
  nickname: LS.nickname,
  roomCode: null,
  playerId: null,
  players: [],       // son room:state
  inRoom: false,
  countdownRaf: null,
};

/* ============================================================
 * UI modülleri
 * ============================================================ */
const lobbyUI = initLobby({
  getNickname: () => state.nickname,
  onCreate: handleCreateRoom,
  onJoin: handleJoinRoom,
  onReady: handleReady,
  onLeave: handleLeaveToMenu,
  onMenu: handleLeaveToMenu,
  onChangeNick: (nick) => {
    state.nickname = nick;
    LS.nickname = nick;
    lobbyUI.setMenuNickname(nick);
    screens.show('screen-menu');
  },
  showToast,
  screens,
});

const gameUI = initGameScreen({
  submitWord: (word) => KSNet.submitWord(word),
  Sound,
  fx,
  showToast,
  getYou: () => ({ nickname: state.nickname }),
  getFoe: () => state.players.find((p) => p.id !== state.playerId),
  avatarFor,
});

const resultsUI = initResults({
  avatarFor,
  onRematch: handleRematch,
  onMenu: handleLeaveToMenu,
});

/* ============================================================
 * AKIŞ — Oda kur
 * ============================================================ */
async function handleCreateRoom() {
  const res = await KSNet.createRoom(state.nickname);
  if (!res.ok) { showToast(res.error || 'Oda kurulamadı', 'bad'); return; }
  state.roomCode = res.roomCode;
  state.playerId = res.playerId;
  state.inRoom = true;
  saveToken(res.playerToken);
  lobbyUI.renderCreateCode(res.roomCode);
  screens.show('screen-create');
}

/* ============================================================
 * AKIŞ — Odaya katıl
 * ============================================================ */
async function handleJoinRoom(code) {
  const res = await KSNet.joinRoom(code, state.nickname);
  if (!res.ok) {
    lobbyUI.showJoinError(res.error === 'Oda bulunamadı' ? '🔎 Böyle bir oda yok — kodu kontrol et' : res.error);
    return;
  }
  state.roomCode = res.roomCode;
  state.playerId = res.playerId;
  state.inRoom = true;
  saveToken(res.playerToken);
  enterLobby();
}

/* ============================================================
 * AKIŞ — Lobi
 * ============================================================ */
function enterLobby() {
  renderLobbyFromState();
  screens.show('screen-lobby');
}

function renderLobbyFromState() {
  lobbyUI.renderLobby({
    players: state.players,
    youId: state.playerId,
    code: state.roomCode,
  });
}

async function handleReady(ready) {
  await KSNet.setReady(ready);
}

/* ============================================================
 * AKIŞ — Geri sayım
 * ============================================================ */
function startCountdown(endsAt) {
  screens.show('screen-countdown');
  const numEl = document.getElementById('count-num');
  let lastN = null;
  let showedGo = false;

  cancelAnimationFrame(state.countdownRaf);
  clearInterval(state.countdownIv);
  const loop = () => {
    const remaining = endsAt - Date.now();
    const n = Math.ceil(remaining / 1000);
    if (n !== lastN && n > 0) {
      lastN = n;
      numEl.className = 'count-num';
      void numEl.offsetWidth;
      numEl.classList.add('tick-anim');
      numEl.textContent = String(n);
      Sound.tick();
    }
    if (remaining <= 0 && !showedGo) {
      showedGo = true;
      numEl.className = 'count-num count-go';
      void numEl.offsetWidth;
      numEl.classList.add('tick-anim');
      numEl.textContent = 'BAŞLA!';
      Sound.go();
      clearInterval(state.countdownIv); // game:start gelince ekran değişir
    }
  };
  loop();
  state.countdownIv = setInterval(loop, 200);
}

/* ============================================================
 * AKIŞ — Oyun başlat
 * ============================================================ */
function handleGameStart({ letters, duration, endsAt }) {
  cancelAnimationFrame(state.countdownRaf);
  const foe = state.players.find((p) => p.id !== state.playerId);
  gameUI.startGame({
    letters,
    duration,
    endsAt,
    youInfo: { id: state.playerId, nickname: state.nickname },
    foeInfo: { nickname: foe?.nickname ?? 'Rakip' },
  });
  screens.show('screen-game');
}

/* ============================================================
 * AKIŞ — Maç sonu
 * ============================================================ */
function handleGameEnd(payload) {
  gameUI.finish();
  resultsUI.render(payload, { youId: state.playerId });
  screens.show('screen-results');
  const you = payload.results.find((r) => r.id === state.playerId);
  if (payload.winner === 'tie') Sound.go();
  else if (payload.winner === state.playerId) Sound.win();
  else Sound.lose();
  if (you && payload.winner !== state.playerId && payload.winner !== 'tie') {
    showToast(`${payload.winnerNickname} kazandı — bir dahakine!`);
  }
}

/* ============================================================
 * AKIŞ — Tekrar oyna
 * ============================================================ */
async function handleRematch() {
  await KSNet.playAgain();
  // game:rematch olayı gelince lobiye dönülür; host ise anında döner
}

/* ============================================================
 * AKIŞ — Menüye dönüş / ayrılma
 * ============================================================ */
function handleLeaveToMenu() {
  cancelAnimationFrame(state.countdownRaf);
  clearInterval(state.countdownIv);
  gameUI.reset();
  if (state.inRoom) KSNet.leave();
  state.inRoom = false;
  state.roomCode = null;
  state.playerId = null;
  state.players = [];
  LS.clearToken();
  try { sessionStorage.removeItem('ks_ownToken'); } catch { /* yoksay */ }
  lobbyUI.setMenuNickname(state.nickname);
  screens.show('screen-menu');
}

/* ============================================================
 * Ağ bandı — socket modunda sunucu erişilemezse (mock: hiç tetiklenmez)
 * ============================================================ */
const netBanner = document.getElementById('net-banner');
const netBannerMsg = document.getElementById('net-banner-msg');
const btnMockMode = document.getElementById('btn-mock-mode');

function showNetBanner(msg) {
  if (!netBanner) return;
  if (msg) netBannerMsg.textContent = msg;
  netBanner.hidden = false;
}

function hideNetBanner() {
  if (netBanner) netBanner.hidden = true;
}

btnMockMode?.addEventListener('click', () => {
  // Tek sekme mock multiplayer: sayfayı ?mock=1 ile yeniden aç
  const url = new URL(location.href);
  url.searchParams.set('mock', '1');
  location.replace(url.href);
});

/* ============================================================
 * KSNet olay bağlama
 * ============================================================ */
KSNet.on('room:state', (st) => {
  state.players = st.players || [];

  // geri sayım/oyun sırasında LOBBY'ye düşüldüyse (rakip ayrıldı) lobiye dön
  if (st.state === 'LOBBY') {
    if (screens.isActive('screen-countdown') || screens.isActive('screen-game')) {
      gameUI.reset();
      enterLobby();
      showToast('Rakip ayrıldı — lobiye dönüldü');
      return;
    }
    if (screens.isActive('screen-lobby')) renderLobbyFromState();
    return;
  }
  if (screens.isActive('screen-lobby')) renderLobbyFromState();
});

KSNet.on('room:playerJoined', ({ nickname }) => {
  showToast(`🧝 ${nickname} katıldı!`);
  Sound.foeFound();
  if (screens.isActive('screen-create')) enterLobby();
});

KSNet.on('room:playerLeft', ({ nickname }) => {
  if (!screens.isActive('screen-results')) {
    showToast(`👋 ${nickname} ayrıldı`, 'bad');
  }
});

KSNet.on('game:countdown', ({ endsAt }) => startCountdown(endsAt));

KSNet.on('game:start', handleGameStart);

KSNet.on('word:accepted', (payload) => gameUI.onRemoteAccept(payload));

KSNet.on('game:timeSync', ({ endsAt }) => gameUI.setEndsAt(endsAt));

KSNet.on('game:end', handleGameEnd);

KSNet.on('game:rematch', () => {
  resultsUI.resetRematchButton();
  enterLobby();
  showToast('Yeni tur! Hazır olun 🌿');
});

KSNet.on('net:down', () => {
  showToast('Bağlantı koptu 💔', 'bad');
  setTimeout(() => handleLeaveToMenu(), 900);
});

KSNet.on('room:recovered', () => {
  showToast('Bağlantı geri geldi 🌿');
});

// Socket modu bağlantı durumu (mock hiç emit etmez — noop)
let netWasUp = false;
KSNet.on('net:status', ({ status } = {}) => {
  if (KSNet.mode !== 'socket') return;
  if (status === 'connected') {
    hideNetBanner();
    if (netWasUp) showToast('Bağlantı geri geldi 🌿');
    netWasUp = true;
  } else if (status === 'reconnecting') {
    showToast('🔄 Yeniden bağlanılıyor…');
  } else if (status === 'connect_error') {
    showNetBanner('Sunucuya ulaşılamıyor');
  }
  // 'disconnected' bilerek sessiz: hemen ardından 'reconnecting' toast'ı gelir
});

// Socket modu: ağ koptu → geri geldi → tam state replay (skor/kelime/timer senkron)
KSNet.on('room:resync', (res) => {
  if (!res?.ok || !state.inRoom) return;
  applyRoomSnapshot(res);
  if (res.state === 'PLAYING') showToast('Senkronize edildi ⚡');
});

/* ============================================================
 * Reconnect — sayfa yenilendiğinde (görsel rebuild akışı)
 * applyRoomSnapshot: mock + socket ortak — tam oda state'ini UI'ya uygular
 * (boot tryReconnect ve socket room:resync aynı yolu kullanır)
 * ============================================================ */
function applyRoomSnapshot(res) {
  state.roomCode = res.code;
  state.playerId = res.you.id;
  state.inRoom = true;
  state.players = res.roomState?.players ?? [];

  if (res.state === 'PLAYING') {
    // OYUN EKRAN TAM REBUILD: skorlar + kelimeler + timer kaldığı yerden
    const foe = res.opponent;
    gameUI.rebuild({
      letters: res.letters,
      endsAt: res.endsAt,
      duration: res.duration,
      youWords: res.you.words,
      foeWords: foe?.words ?? [],
      youScore: res.you.score,
      foeScore: foe?.score ?? 0,
      youNickname: res.you.nickname,
      foeNickname: foe?.nickname,
    });
    screens.show('screen-game');
    return true;
  }

  if (res.state === 'RESULTS' && res.lastEnd) {
    handleGameEnd(res.lastEnd);
    return true;
  }

  // LOBBY / COUNTDOWN
  enterLobby();
  if (res.state === 'COUNTDOWN') startCountdown(res.endsAt);
  return true;
}

async function tryReconnect() {
  const token = ownToken();
  if (!token) return false;
  const res = await KSNet.reconnect(token);
  if (!res.ok) {
    LS.clearToken();
    try { sessionStorage.removeItem('ks_ownToken'); } catch { /* yoksay */ }
    return false;
  }
  saveToken(token);
  const reconnected = applyRoomSnapshot(res);
  if (res.state === 'PLAYING') showToast('Bağlantı kuruldu — oyuna devam! ⚡');
  return reconnected;
}

/* ============================================================
 * Ateşböcekleri (dekoratif — reduced-motion'da CSS gizler)
 * ============================================================ */
(function spawnFireflies() {
  const holder = document.getElementById('fireflies');
  for (let i = 0; i < 9; i++) holder.appendChild(document.createElement('span'));
})();

/* ============================================================
 * Susturma düğmesi
 * ============================================================ */
const muteBtn = document.getElementById('btn-mute');
function renderMute() {
  muteBtn.textContent = Sound.muted ? '🔇' : '🔊';
  muteBtn.setAttribute('aria-pressed', String(Sound.muted));
  muteBtn.setAttribute('aria-label', Sound.muted ? 'Sesi aç' : 'Sesi kapat');
}
muteBtn.addEventListener('click', () => { Sound.toggle(); renderMute(); });
renderMute();

/* ============================================================
 * AÇILIŞ
 * ============================================================ */
(async function boot() {
  if (state.nickname) {
    lobbyUI.prefillNickname(state.nickname);
    const reconnected = await tryReconnect().catch(() => false);
    // Guard: reconnect beklerken (ör. 1.6sn timeout) net olayı ekranı çoktan
    // değiştirmiş olabilir (lobi/oyun) — üzerine yazma.
    if (!reconnected && !screens.current) screens.show('screen-menu');
  } else {
    if (!screens.current) screens.show('screen-nickname');
    setTimeout(() => document.getElementById('input-nickname')?.focus(), 350);
  }
})();

// Hata yakalama (geliştirme yardımı)
window.addEventListener('error', (e) => console.error('[KS]', e.message, e.filename, e.lineno));
