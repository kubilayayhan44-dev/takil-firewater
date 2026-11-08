/**
 * Kelime Savaşı — ui/wheel.js
 * 6 harfli harf çemberi: Pointer Events (tek API'de touch+mouse)
 * bas-sürükle-bırak ile seçim + SVG yumuşak çizgi + dokunarak biriktirme.
 *
 * Seçim modeli:
 *  - pointerdown bir harfe denk gelirse harf eklenir (yeni stroke başlar)
 *  - geri gitmek: bir önceki seçili harfe geri dön → son harf silinir
 *  - sürükleme eşiği aşıldıysa → bırakınca kelime submit edilir (≥3 harfse)
 *  - eşik aşılmadıysa (tek dokunuş) → seçim birikir (sticky), ⌫/✓ düğmeleriyle yönetilir
 */

'use strict';

const TILE_HIT_FACTOR = 0.72; // parmağın harf merkeze yakınlık toleransı (tile yarıçapı ×)
const DRAG_THRESHOLD = 16;   // px — bunu aşan hareket = sürükleme

export function createWheel(rootEl, handlers = {}) {
  const svg = rootEl.querySelector('.wheel-svg');
  const tilesEl = rootEl.querySelector('.wheel-tiles');
  const { onWord, onSelectionChange, onSelect } = handlers;

  let letters = [];
  let tiles = [];          // [{el, x, y}] — root koordinat sisteminde merkezler
  let selection = [];      // seçili tile index'leri (sıra = kelime sırası)
  let locked = false;

  let activePointerId = null;
  let downPoint = null;
  let dragged = false;
  let strokeActive = false;
  let ro = null;

  /* ---------- konumlandırma ---------- */
  function layout() {
    const rect = rootEl.getBoundingClientRect();
    if (rect.width < 10) return;
    const size = tiles.length
      ? tiles[0].el.getBoundingClientRect().width
      : parseFloat(getComputedStyle(rootEl).getPropertyValue('--tile-size')) || 64;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const radius = Math.min(rect.width, rect.height) / 2 - size / 2 - 6;

    tiles.forEach((t, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(tiles.length, 1);
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      t.x = x; t.y = y;
      // left/top ile konum (transform alanı ölçek/glow animasyonuna kalsın)
      t.el.style.left = `${x}px`;
      t.el.style.top = `${y}px`;
    });

    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    drawPath();
  }

  /* ---------- render ---------- */
  function render(newLetters) {
    letters = Array.from(newLetters);
    selection = [];
    tilesEl.innerHTML = '';
    svg.innerHTML = '';

    tiles = letters.map((ch, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'wheel-tile';
      el.dataset.index = i;
      el.setAttribute('aria-label', `Harf ${ch.toUpperCase()}`);
      el.innerHTML = `<span class="tile-face">${ch}</span><span class="tile-badge"></span>`;
      tilesEl.appendChild(el);
      return { el, x: 0, y: 0 };
    });

    layout();
    emitSelection();
  }

  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => layout());
    ro.observe(rootEl);
  } else {
    window.addEventListener('resize', layout);
  }

  /* ---------- yardımcılar ---------- */
  function getRect() { return rootEl.getBoundingClientRect(); }

  function hitTest(clientX, clientY) {
    const rect = getRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const size = tiles.length
      ? tiles[0].el.getBoundingClientRect().width
      : 64;
    const hitR = size * TILE_HIT_FACTOR;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < tiles.length; i++) {
      const dx = px - tiles[i].x;
      const dy = py - tiles[i].y;
      const d = Math.hypot(dx, dy);
      if (d <= hitR && d < bestDist) { best = i; bestDist = d; }
    }
    return best >= 0 ? best : null;
  }

  function isSelected(i) { return selection.includes(i); }

  function selectTile(i) {
    if (locked || isSelected(i)) return;
    selection.push(i);
    const t = tiles[i];
    t.el.classList.add('t-selected');
    t.el.querySelector('.tile-badge').textContent = String(selection.length);
    drawPath();
    emitSelection();
    onSelect?.(i, selection.length);
  }

  function popTile() {
    const i = selection.pop();
    if (i === undefined) return;
    const t = tiles[i];
    t.el.classList.remove('t-selected');
    drawPath();
    emitSelection();
  }

  function clearSelection() {
    selection.forEach((i) => {
      const t = tiles[i];
      if (!t) return;
      t.el.classList.remove('t-selected');
      const badge = t.el.querySelector('.tile-badge');
      if (badge) badge.textContent = '';
    });
    selection = [];
    drawPath();
    emitSelection();
  }

  function emitSelection() {
    onSelectionChange?.(selection.map((i) => letters[i]), selection.length);
  }

  function currentWord() {
    return selection.map((i) => letters[i]).join('');
  }

  /* ---------- SVG çizgi ---------- */
  function drawPath() {
    const pts = selection.map((i) => ({ x: tiles[i].x, y: tiles[i].y }));
    if (pts.length < 2) { svg.innerHTML = ''; return; }

    // Orta noktalardan geçen yumuşak quadratic eğri
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${last.x} ${last.y}`;

    svg.innerHTML = `<path d="${d}"></path>`;
  }

  /* ---------- Pointer akışı ---------- */
  rootEl.addEventListener('pointerdown', (e) => {
    if (locked) return;
    e.preventDefault();
    activePointerId = e.pointerId;
    downPoint = { x: e.clientX, y: e.clientY };
    dragged = false;
    try { rootEl.setPointerCapture(e.pointerId); } catch { /* yoksay */ }

    const hit = hitTest(e.clientX, e.clientY);
    if (hit === null) { strokeActive = false; return; }
    strokeActive = true;
    handleHit(hit);
  });

  rootEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointerId || locked) return;
    if (downPoint && Math.hypot(e.clientX - downPoint.x, e.clientY - downPoint.y) > DRAG_THRESHOLD) {
      dragged = true;
    }
    const hit = hitTest(e.clientX, e.clientY);
    if (hit !== null) {
      strokeActive = true;
      handleHit(hit);
    }
  });

  function endStroke(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    downPoint = null;
    try { rootEl.releasePointerCapture(e.pointerId); } catch { /* yoksay */ }

    if (!strokeActive) return;
    strokeActive = false;

    if (e.type === 'pointercancel') {
      // sistem çizgiyi böldü — seçimi sessizce bırak
      clearSelection();
      return;
    }

    if (dragged) {
      // bas-sürükle-bırak: bırak = submit
      const word = currentWord();
      clearSelection();
      if (word.length >= 3) onWord?.(word);
      return;
    }
    // tek dokunuş → sticky birikim: seçim kalır, ⌫/✓ ile yönetilir
  }

  rootEl.addEventListener('pointerup', endStroke);
  rootEl.addEventListener('pointercancel', endStroke);

  function handleHit(i) {
    if (locked) return;
    if (isSelected(i)) {
      // bir önceki seçili harfe döndüyse → geri al (backtrack)
      if (selection.length >= 2 && i === selection[selection.length - 2]) {
        popTile();
      }
      return; // son seçili veya daha eski — yok say
    }
    selectTile(i);
  }

  /* ---------- dış API ---------- */
  return {
    render,
    clearSelection,
    popTile: () => { if (selection.length) popTile(); },
    getWord: currentWord,
    getSelection: () => selection.slice(),
    submitSticky() {
      const word = currentWord();
      clearSelection();
      if (word.length >= 3) onWord?.(word);
      return word;
    },
    setLocked(v) {
      locked = !!v;
      if (locked) clearSelection();
    },
    /** Harf pozisyonu (fx patlaması için) — index veya son seçili */
    tilePoint(i) {
      const idx = typeof i === 'number' ? i : selection[selection.length - 1];
      if (idx === undefined || !tiles[idx]) return null;
      const rect = getRect();
      return { x: rect.left + tiles[idx].x, y: rect.top + tiles[idx].y };
    },
    destroy() {
      ro?.disconnect();
      window.removeEventListener?.('resize', layout);
    },
  };
}

export default createWheel;
