/**
 * Kelime Savaşı — ui/lobby.js
 * Ekran 1-5: nickname → menü → oda kur (kod) → odaya katıl (keypad) → lobi.
 * DOM referansları + davranışlar; ağ çağrıları main.js'ten enjekte edilir.
 */

'use strict';

// Oda kodu alfabesi: A-Z arasından I, L, O, U hariç (görsel belirsizlik yok)
const CODE_ALPHABET = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K',
  'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'X', 'Y', 'Z'];

const AVATARS = ['🦊', '🐼', '🦉', '🐺', '🦋', '🦜', '🐿️', '🐸', '🦎', '🦔', '🕷️', '🦇', '🦌', '🐍', '🦝', '🦩'];

export function avatarFor(nickname) {
  let h = 0;
  for (const ch of String(nickname || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

export function initLobby(deps) {
  const {
    getNickname, onCreate, onJoin, onReady, onLeave, onMenu, onChangeNick,
    showToast, screens,
  } = deps;

  /* ================= EKRAN 1 — NİCKNAME ================= */
  const form = document.getElementById('form-nickname');
  const nickInput = document.getElementById('input-nickname');
  const nickError = document.getElementById('nickname-error');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = nickInput.value.trim();
    if (val.length < 2) {
      nickError.textContent = 'En az 2 karakter gir 🌱';
      nickError.hidden = false;
      nickInput.focus();
      return;
    }
    if (val.length > 16) {
      nickError.textContent = 'En fazla 16 karakter';
      nickError.hidden = false;
      return;
    }
    nickError.hidden = true;
    onChangeNick(val); // main: kaydet + menüye geç
  });

  /* ================= EKRAN 2 — MENÜ ================= */
  document.getElementById('menu-nickname').textContent = getNickname() || 'Misafir';
  document.getElementById('btn-create').addEventListener('click', onCreate);
  document.getElementById('btn-join').addEventListener('click', () => {
    resetJoin();
    screens.show('screen-join');
  });
  document.getElementById('btn-change-nick').addEventListener('click', () => {
    nickInput.value = getNickname() || '';
    screens.show('screen-nickname');
  });

  /* ================= EKRAN 3 — ODA KUR ================= */
  document.getElementById('btn-back-create').addEventListener('click', onLeave);
  document.getElementById('btn-copy').addEventListener('click', async () => {
    const code = document.getElementById('create-code').dataset.code || '';
    if (!code) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
    } catch {
      // http/izinsiz context fallback
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch { /* yoksay */ }
    }
    showToast(copied ? '📋 Kod kopyalandı!' : `Kod: ${code}`);
  });

  /* ================= EKRAN 4 — ODAYA KATIL ================= */
  const slots = Array.from(document.querySelectorAll('#join-slots .slot'));
  const keypadEl = document.getElementById('join-keypad');
  const joinGo = document.getElementById('join-go');
  const joinBack = document.getElementById('join-back');
  const joinError = document.getElementById('join-error');
  let codeBuf = '';

  // Keypad: 22 harf + 6 sütunluk grid
  for (const letter of CODE_ALPHABET) {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'key';
    key.textContent = letter;
    key.dataset.letter = letter;
    key.setAttribute('aria-label', `Harf ${letter}`);
    keypadEl.appendChild(key);
  }

  function renderSlots() {
    slots.forEach((s, i) => {
      s.textContent = codeBuf[i] || '';
      s.classList.toggle('filled', i < codeBuf.length);
      s.classList.toggle('cursor', i === codeBuf.length);
    });
    joinGo.disabled = codeBuf.length !== 4;
  }

  function pressLetter(letter) {
    if (codeBuf.length >= 4) return;
    codeBuf += letter;
    joinError.hidden = true;
    renderSlots();
  }

  function pressBack() {
    codeBuf = codeBuf.slice(0, -1);
    joinError.hidden = true;
    renderSlots();
  }

  function resetJoin() {
    codeBuf = '';
    joinError.hidden = true;
    joinGo.disabled = true;
    renderSlots();
  }

  keypadEl.addEventListener('click', (e) => {
    const key = e.target.closest('.key[data-letter]');
    if (key) pressLetter(key.dataset.letter);
  });

  joinBack.addEventListener('click', pressBack);
  joinGo.addEventListener('click', () => {
    if (codeBuf.length === 4) onJoin(codeBuf);
  });
  document.getElementById('btn-back-join').addEventListener('click', onMenu);

  // Fiziksel klavye desteği (masaüstü test kolaylığı)
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('screen-join').classList.contains('active')) return;
    if (e.key === 'Backspace') { pressBack(); e.preventDefault(); }
    else if (e.key === 'Enter' && codeBuf.length === 4) onJoin(codeBuf);
    else {
      const L = e.key.toUpperCase();
      if (L.length === 1 && CODE_ALPHABET.includes(L)) pressLetter(L);
    }
  });

  function showJoinError(message) {
    joinError.textContent = message;
    joinError.hidden = false;
    codeBuf = '';
    renderSlots();
  }

  /* ================= EKRAN 5 — LOBİ ================= */
  const lobbyCodeEl = document.getElementById('lobby-code');
  const p1El = document.getElementById('lobby-p1');
  const p2El = document.getElementById('lobby-p2');
  const lobbyHint = document.getElementById('lobby-hint');

  function playerCardHTML(p, isYou) {
    const ready = p.ready
      ? '<span class="pc-ready-chip">✓ HAZIR</span>'
      : '<span class="pc-ready-chip chip-wait">bekliyor…</span>';
    return `
      <span class="pc-avatar" aria-hidden="true">${avatarFor(p.nickname)}</span>
      <span class="pc-name">${escapeHtml(p.nickname)}${isYou ? ' <small style="opacity:.6">(sen)</small>' : ''}</span>
      ${ready}
      ${isYou ? '<button class="pc-ready-btn" type="button"></button>' : ''}
    `;
  }

  function emptyCardHTML() {
    return `
      <span class="pc-avatar" aria-hidden="true">🧚</span>
      <span class="pc-name">rakip bekleniyor…</span>
    `;
  }

  function renderLobby({ players, youId, code, state }) {
    lobbyCodeEl.textContent = code || '····';
    const you = players.find((p) => p.id === youId);
    const foe = players.find((p) => p.id !== youId);

    // Sol kart = sen
    p1El.className = 'player-card' + (you ? ' pc-you' : ' pc-empty');
    p1El.innerHTML = you ? playerCardHTML(you, true) : emptyCardHTML();

    // Sağ kart = rakip
    p2El.className = 'player-card' + (foe ? '' : ' pc-empty');
    p2El.innerHTML = foe
      ? playerCardHTML(foe, false)
      : `<span class="pc-avatar" aria-hidden="true">🕯️</span><span class="pc-name">boş</span>`;

    // HAZIR düğmesi
    const btn = p1El.querySelector('.pc-ready-btn');
    if (btn) {
      btn.textContent = you?.ready ? '✓ HAZIRIM' : 'HAZIR';
      btn.classList.toggle('is-ready', !!you?.ready);
      btn.setAttribute('aria-pressed', String(!!you?.ready));
      btn.onclick = () => onReady(!you?.ready);
    }

    const readyCount = players.filter((p) => p.ready).length;
    lobbyHint.textContent = players.length < 2
      ? 'Rakibin katılmasını bekle…'
      : readyCount < 2
        ? 'İkiniz de hazır olunca geri sayım başlar'
        : 'Hazırsın! Geri sayım başlıyor…';
  }

  /* ================= yardımcı ================= */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderCreateCode(code) {
    const el = document.getElementById('create-code');
    el.dataset.code = code;
    el.innerHTML = Array.from(code)
      .map((ch) => `<span class="slot">${ch}</span>`)
      .join('');
  }

  return {
    renderCreateCode,
    resetJoin,
    showJoinError,
    renderLobby,
    setMenuNickname(name) {
      document.getElementById('menu-nickname').textContent = name;
    },
    prefillNickname(name) {
      nickInput.value = name || '';
    },
  };
}

export default initLobby;
