/**
 * Kelime Savaşı — ui/results.js
 * Ekran 8: kazanan ilanı animasyonu, skor karşılaştırması,
 * TAM çözüm listesi (bulunanlar parlak / kaçırılanlar soluk).
 */

'use strict';

export function initResults(deps) {
  const { avatarFor, onRematch, onMenu } = deps;

  const trophy = document.getElementById('results-trophy');
  const winnerName = document.getElementById('winner-name');
  const winnerLabel = document.getElementById('winner-label');
  const scoreCompare = document.getElementById('score-compare');
  const solutionsGrid = document.getElementById('solutions-grid');
  const solCount = document.getElementById('sol-count');
  const btnRematch = document.getElementById('btn-rematch');
  const btnMenu = document.getElementById('btn-menu');

  btnRematch.addEventListener('click', () => {
    btnRematch.disabled = true;
    btnRematch.textContent = 'RAKİP BEKLENİYOR…';
    onRematch();
  });
  btnMenu.addEventListener('click', onMenu);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /**
   * payload: {results, winner, winnerNickname, reason, solutionList}
   * ctx: {youId}
   */
  function render(payload, { youId }) {
    const { results, winner, winnerNickname, solutionList } = payload;
    const you = results.find((r) => r.id === youId);
    const foe = results.find((r) => r.id !== youId);

    // --- kahraman alanı ---
    trophy.className = 'trophy';
    if (winner === 'tie') {
      trophy.textContent = '🤝';
      trophy.classList.add('trophy-draw');
      winnerName.textContent = 'BERABERE';
      winnerLabel.textContent = 'EŞİT GÜÇLÜ RAKİPLER';
    } else if (winner === youId) {
      trophy.textContent = '🏆';
      winnerName.textContent = `${you.nickname} KAZANDI!`;
      winnerLabel.textContent = 'ORMANIN EFENDİSİ 🌿';
    } else {
      trophy.textContent = '🛡️';
      trophy.classList.add('trophy-lose');
      winnerName.textContent = `${foe?.nickname ?? 'Rakip'} kazandı`;
      winnerLabel.textContent = 'BİR DAHAKİNE! 💪';
    }

    // animasyonu yeniden tetikle
    trophy.classList.remove('trophy'); void trophy.offsetWidth; trophy.classList.add('trophy');

    // --- skor karşılaştırma ---
    const maxScore = Math.max(1, ...results.map((r) => r.score));
    const youLongest = you ? (you.words.reduce((m, w) => Math.max(m, w.word.length), 0)) : 0;
    const foeLongest = foe ? (foe.words.reduce((m, w) => Math.max(m, w.word.length), 0)) : 0;

    scoreCompare.innerHTML = `
      <div class="sc-row sc-you">
        <span class="sc-name">${escapeHtml(you?.nickname ?? 'Sen')}</span>
        <span class="sc-track"><span class="sc-fill" style="--w:${(you?.score ?? 0) / maxScore}"></span></span>
        <span class="sc-score">${you?.score ?? 0}</span>
      </div>
      <div class="sc-row sc-foe">
        <span class="sc-name">${escapeHtml(foe?.nickname ?? 'Rakip')}</span>
        <span class="sc-track"><span class="sc-fill" style="--w:${(foe?.score ?? 0) / maxScore}"></span></span>
        <span class="sc-score">${foe?.score ?? 0}</span>
      </div>
      <div class="sc-sub">
        <span>${avatarFor(you?.nickname)} ${you?.words.length ?? 0} kelime • en uzun ${youLongest} harf</span>
        <span>${foe?.words.length ?? 0} kelime • en uzun ${foeLongest} harf ${avatarFor(foe?.nickname)}</span>
      </div>
    `;
    // bar animasyonu (transition transform)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scoreCompare.querySelectorAll('.sc-fill').forEach((el) => {
          el.style.transform = `scaleX(${el.style.getPropertyValue('--w') || 0})`;
        });
      });
    });

    // --- tam çözüm listesi ---
    const foundSet = new Map(); // word → {you, foe, points}
    for (const w of you?.words ?? []) foundSet.set(w.word, { you: true, foe: false, points: w.points });
    for (const w of foe?.words ?? []) {
      const e = foundSet.get(w.word) ?? { you: false, points: w.points };
      e.foe = true;
      foundSet.set(w.word, e);
    }

    const foundCount = [...foundSet.values()].filter((e) => e.you).length;
    solCount.textContent = `${foundCount} / ${solutionList.length}`;

    const pts = { 3: 10, 4: 25, 5: 50, 6: 100 };
    solutionsGrid.innerHTML = solutionList
      .map((word, i) => {
        const e = foundSet.get(word);
        const mine = e?.you;
        const cls = mine ? 'sol' : 'sol sol-miss';
        const mark = e?.you && e?.foe ? '⚔️' : e?.you ? '✨' : e?.foe ? '➶' : '';
        return `<span class="${cls}" style="animation-delay:${Math.min(i * 18, 600)}ms">${word}<small>${pts[word.length] ?? ''} ${mark}</small></span>`;
      })
      .join('');

    // rematch düğmesini sıfırla
    btnRematch.disabled = false;
    btnRematch.textContent = '🔄 TEKRAR OYNA';
  }

  function resetRematchButton() {
    btnRematch.disabled = false;
    btnRematch.textContent = '🔄 TEKRAR OYNA';
  }

  return { render, resetRematchButton };
}

export default initResults;
