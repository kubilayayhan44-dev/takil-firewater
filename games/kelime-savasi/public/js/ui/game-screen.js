/**
 * Kelime Savaşı — ui/game-screen.js
 * Ekran 7: HUD (timer + çift skor), kelime gösterimi, harf çemberi,
 * rakip ticker'ı, bulunan kelimeler ızgarası, submit feedback.
 */

'use strict';

import { createWheel } from './wheel.js';

export function initGameScreen(deps) {
  const {
    submitWord,        // (word) => Promise<ack>
    Sound, fx, showToast,
    getYou, getFoe,    // () => {nickname, ...}
    avatarFor,
  } = deps;

  /* ---- DOM ---- */
  const youName = document.getElementById('hud-you-name');
  const youScore = document.getElementById('hud-you-score');
  const youAvatar = document.getElementById('hud-you-avatar');
  const foeName = document.getElementById('hud-foe-name');
  const foeScore = document.getElementById('hud-foe-score');
  const foeAvatar = document.getElementById('hud-foe-avatar');
  const timerNum = document.getElementById('timer-num');
  const timerBar = document.querySelector('.timer-bar');
  const timerFill = document.getElementById('timer-fill');
  const ticker = document.getElementById('ticker');
  const wordDisplay = document.getElementById('word-display');
  const stickyActions = document.getElementById('sticky-actions');
  const foundGrid = document.getElementById('found-grid');
  const foundCount = document.getElementById('found-count');
  const wheelRoot = document.getElementById('wheel');

  /* ---- durum ---- */
  let endsAt = 0;
  let duration = 90_000;
  let tickId = null; // setInterval kimliği (rAF kullanılmıyor — arka planda da akar)
  let running = false;
  let locked = false;
  let lastShownSec = null;
  let you = null;
  let foe = null;
  let foundWords = new Map(); // word → {chipEl, byYou, byFoe, points}

  /* ============================================================
   * HARF ÇEMBERİ
   * ============================================================ */
  let wheel = createWheel(wheelRoot, {
    onWord: handleSubmit,
    onSelectionChange: renderWord,
    onSelect: (_i, count) => Sound.letter(count),
  });

  // sticky (dokunarak biriktirme) eylem düğmeleri
  document.getElementById('sticky-back').addEventListener('click', () => wheel.popTile());
  document.getElementById('sticky-go').addEventListener('click', () => wheel.submitSticky());

  async function handleSubmit(word) {
    if (locked) return;
    const ack = await submitWord(word);
    if (ack.ok) {
      handleAccept({
        word: ack.word, points: ack.points, score: ack.totalScore, byYou: true,
      });
    } else {
      handleReject(word, ack.reason);
    }
  }

  function renderWord(lettersArr) {
    stickyActions.hidden = !(lettersArr && lettersArr.length > 0);
    if (!lettersArr || lettersArr.length === 0) {
      wordDisplay.innerHTML = '<span class="word-placeholder">parmağınla kelime çiz…</span>';
      return;
    }
    wordDisplay.innerHTML = lettersArr
      .map((ch) => `<span class="wd-letter">${ch}</span>`)
      .join('');
  }

  /* ============================================================
   * TIMER (endsAt bazlı — server/otorite saatine kilitli)
   *
   * setInterval tabanlı tick (~250ms): sekme arka plana alınınca rAF
   * tamamen durur, interval ise (tarayıcı kısmı throttle'ı dışında)
   * çalışmaya devam eder → HUD timer'ı arka planda da akar, öne dönünce
   * sıçrama olmaz. endsAt bazlı olduğundan throttle altında bile doğru.
   * ============================================================ */
  function startTimer(endsAtMs, durationMs) {
    endsAt = endsAtMs;
    if (durationMs) duration = durationMs;
    running = true;
    lastShownSec = null;
    if (tickId) { clearInterval(tickId); tickId = null; }
    const tick = () => {
      if (!running) return;
      const remaining = Math.max(0, endsAt - Date.now());
      const ratio = Math.max(0, Math.min(1, remaining / duration));
      // sadece transform — layout tetikleme yok
      timerFill.style.transform = `scaleX(${ratio})`;
      const sec = Math.ceil(remaining / 1000);
      if (sec !== lastShownSec) {
        lastShownSec = sec;
        timerNum.textContent = String(sec);
        timerBar.classList.toggle('danger', sec <= 10 && sec > 0);
        if (sec <= 5 && sec > 0) Sound.tickLow?.();
      }
      if (remaining <= 0) {
        running = false;
        if (tickId) { clearInterval(tickId); tickId = null; }
        setLocked(true);
        return;
      }
    };
    tick();
    tickId = setInterval(tick, 250);
  }

  function setEndsAt(t) { endsAt = t; }

  function stopTimer() {
    running = false;
    if (tickId) { clearInterval(tickId); tickId = null; }
  }

  /* ============================================================
   * KABUL / RET FEEDBACK
   * ============================================================ */
  function handleAccept({ word, points, score, byYou, byFoe }) {
    // puan uçuşu + parıltı patlaması
    const anchor = wordDisplay.getBoundingClientRect();
    const cx = anchor.left + anchor.width / 2;
    const cy = anchor.top + anchor.height / 2;
    if (byYou) {
      fx.burst(cx, cy, { count: 14 });
      fx.floatText(cx, cy - 12, `+${points}`);
      wordDisplay.classList.remove('wd-accepted');
      void wordDisplay.offsetWidth; // animasyonu resetle
      wordDisplay.classList.add('wd-accepted');
      Sound.accept(word.length);
      if (typeof score === 'number' && you) {
        you.score = score;
        bumpScore(youScore, score);
      }
    } else {
      Sound.foeFound?.();
      fx.burst(cx, cy, { count: 8, color: 'p-violet' });
    }
    addFoundWord(word, points, { byYou, byFoe });
  }

  function handleReject(word, reason) {
    const anchor = wordDisplay.getBoundingClientRect();
    fx.floatText(anchor.left + anchor.width / 2, anchor.top, '✕', { bad: true });
    wordDisplay.classList.remove('wd-shake');
    void wordDisplay.offsetWidth;
    wordDisplay.classList.add('wd-shake');
    Sound.reject();
    showToast(reasonText(reason), 'bad');
  }

  function reasonText(reason) {
    return {
      too_short: 'En az 3 harf gerek 🌱',
      too_long: 'En fazla 6 harf 🌳',
      invalid_chars: 'Geçersiz harfler var',
      not_subset: 'Çemberdeki harflerle uyuşmuyor',
      not_in_dict: 'Sözlükte böyle bir kelime yok 🔮', // mock modu
      not_in_dictionary: 'Sözlükte böyle bir kelime yok 🔮', // gerçek sunucu (server/game.js)
      duplicate: 'Bu kelimeyi zaten buldun',
      taken: 'Bu kelimeyi rakip kaptı! ⚡',
      rate_limited: 'Çok hızlı! Biraz soluklan 🌬️',
      time_up: 'Süre doldu! ⏱️',
      not_playing: 'Maç şu an aktif değil',
      timeout: 'Yanık alınamadı, tekrar dene',
    }[reason] || 'Kelime kabul edilmedi';
  }

  function bumpScore(el, value) {
    el.textContent = String(value);
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  /* ============================================================
   * BULUNAN KELİMELER + TICKER
   * ============================================================ */
  function addFoundWord(word, points, { byYou = false, byFoe = false } = {}) {
    let entry = foundWords.get(word);
    if (!entry) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${escapeHtml(word)} <small>+${points}</small>`;
      foundGrid.prepend(chip);
      entry = { chipEl: chip, byYou: false, byFoe: false, points };
      foundWords.set(word, entry);
    }
    if (byYou) entry.byYou = true;
    if (byFoe) entry.byFoe = true;

    entry.chipEl.classList.toggle('chip-foe', entry.byFoe && !entry.byYou);
    entry.chipEl.classList.toggle('chip-both', entry.byYou && entry.byFoe);
    if (entry.byYou && entry.byFoe) {
      entry.chipEl.innerHTML = `${escapeHtml(word)} <small>+${entry.points} ⚔️</small>`;
    }
    foundCount.textContent = String(foundWords.size);
    if (foundGrid.children.length > 60) foundGrid.lastChild?.remove();
  }

  function addTicker(nickname, word, points) {
    const item = document.createElement('div');
    item.className = 'ticker-item';
    item.innerHTML = `🧝 <span>${escapeHtml(nickname)}:</span> <b>${escapeHtml(word.toUpperCase())}</b> +${points}`;
    ticker.appendChild(item);
    while (ticker.children.length > 3) ticker.firstChild?.remove();
    setTimeout(() => item.remove(), 2700);
  }

  /* ============================================================
   * OYUN BAŞLAT / BİTİR
   * ============================================================ */
  function startGame({ letters, endsAt: endTs, duration: dur, youInfo, foeInfo }) {
    you = { ...youInfo, score: youInfo?.score ?? 0 };
    foe = { ...foeInfo, score: foeInfo?.score ?? 0 };

    youName.textContent = you.nickname || 'Sen';
    youAvatar.textContent = avatarFor(you.nickname);
    foeName.textContent = foe?.nickname || 'Rakip';
    foeAvatar.textContent = avatarFor(foe?.nickname || 'rakip');
    youScore.textContent = String(you.score ?? 0);
    foeScore.textContent = String(foe.score ?? 0);

    foundWords = new Map();
    foundGrid.innerHTML = '';
    foundCount.textContent = '0';
    ticker.innerHTML = '';
    locked = false;
    setLocked(false);

    renderWord([]);
    wheel?.render(letters);
    startTimer(endTs, dur);
  }

  /** Rakip (ya da tekrarlayan kendi) kabulü — net olayından */
  function onRemoteAccept({ id, nickname, word, points, score }) {
    if (!foe) return;
    // kendi kabulümüz ack yoluyla işlendi — atla (aynı isim çakışmasına karşı id bazlı)
    if (id ? id === you?.id : nickname === you?.nickname) return;
    foe.score = score;
    bumpScore(foeScore, score);
    addTicker(nickname, word, points);
    handleAccept({ word, points, score, byYou: false, byFoe: true });
  }

  /** Reconnect: skorlar/kelimeler/timer kaldığı yerden rebuild */
  function rebuild({ letters, endsAt: endTs, duration: dur, youWords = [], foeWords = [], youScore: ys, foeScore: fs, youNickname, foeNickname }) {
    startGame({
      letters, endsAt: endTs, duration: dur,
      youInfo: { nickname: youNickname ?? you?.nickname, score: ys },
      foeInfo: { nickname: foeNickname ?? foe?.nickname, score: fs },
    });
    for (const w of youWords) addFoundWord(w.word, w.points, { byYou: true });
    for (const w of foeWords) {
      // rakibin kelimesi benim listemde varsa "both" olarak işaretlenir
      addFoundWord(w.word, w.points, { byFoe: true });
    }
  }

  function setLocked(v) {
    locked = !!v;
    wheel?.setLocked(v);
    if (v) renderWord([]);
  }

  function finish() {
    stopTimer();
    setLocked(true);
    timerNum.textContent = '0';
    timerFill.style.transform = 'scaleX(0)';
    timerBar.classList.remove('danger');
  }

  function reset() {
    stopTimer();
    finish();
    foundWords = new Map();
    foundGrid.innerHTML = '';
    foundCount.textContent = '0';
    ticker.innerHTML = '';
    renderWord([]);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  return {
    startGame,
    rebuild,
    onRemoteAccept,
    setEndsAt,
    setLocked,
    finish,
    reset,
    get isLocked() { return locked; },
  };
}

export default initGameScreen;
