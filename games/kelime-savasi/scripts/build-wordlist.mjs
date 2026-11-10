#!/usr/bin/env node
// Türkçe kelime listesi pipeline (plan Task 2):
//   LibreOffice hunspell tr_TR.dic
//     → indir (filesystem cache: data/raw/tr_TR.dic)
//     → hunspell stem parse ('/' sonrası flag'ler at, header satırı at)
//     → Türkçe-aware normalize (server/turkce.js — ORTAK modül, kopya yok)
//     → filtre: /^[a-zçğıöşü]{3,6}$/, hunspell özel işaret/özel isim ayıklama
//     → dedupe + Türk alfabesi sıralaması → data/words.tr.json
//
// Kullanım: node scripts/build-wordlist.mjs [--force]   (--force: cache'i yeniden indirir)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../server/config.js';
import { turkceLower, isGameWord, isUpperTr, turkishCompare } from '../server/turkce.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, config.PATHS.WORDS);
const CACHE_PATH = path.join(ROOT, config.PATHS.RAW_DIC_CACHE);
const DIC_URL =
  'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/tr_TR/tr_TR.dic';
const MIN_WORDS = 25_000; // kalite guard — altında exit 1

const force = process.argv.includes('--force');

async function downloadDic() {
  console.log(`⇣ indiriliyor: ${DIC_URL}`);
  const res = await fetch(DIC_URL);
  if (!res.ok) throw new Error(`indirme başarısız: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, text, 'utf8');
  console.log(
    `⇣ cache yazıldı: ${config.PATHS.RAW_DIC_CACHE} (${text.length.toLocaleString('tr-TR')} bayt)`,
  );
  return text;
}

function readCachedDic() {
  console.log(`⇣ cache kullanılıyor: ${config.PATHS.RAW_DIC_CACHE} (--force ile yeniden indirilir)`);
  return readFileSync(CACHE_PATH, 'utf8');
}

/**
 * Hunspell .dic parse (LibreOffice tr_TR formatı):
 *   - 1. satır: stem sayısı header'ı → at ("flags satırı")
 *   - '#' ile başlayan yorum satırları → at (bu dosyada yok, format dayanıklılığı)
 *   - TAB ile başlayan morfoloji devam satırları → at (bu dosyada yok)
 *   - 'kelime/FLAG,FLAG,...' → '/' ÖNCESİ kök alınır; flag'ler numerik affix ID'leri
 *   - TAB sonrası morfoloji tanımı → at
 *   - parantez vb. hunspell özel işaret taşıyan kökler → at (üst simge/rakam regex'te düşer)
 *   - büyük harf içeren kökler (özel isim/kısaltma) → at
 */
function parseDic(text) {
  const report = {
    totalLines: 0,
    header: 0,
    comments: 0,
    continuation: 0,
    blank: 0,
    stems: 0,
    specialMarked: 0,
    properNoun: 0,
    regexFailed: 0,
  };

  const words = new Set();
  let headerSeen = false;

  for (const rawLine of text.split('\n')) {
    report.totalLines++;

    if (rawLine.startsWith('\t')) { report.continuation++; continue; } // morfoloji devamı
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') { report.blank++; continue; }
    if (line.startsWith('#')) { report.comments++; continue; }

    // hunspell header: dosyanın ilk anlamlı satırı, yalnızca sayı
    if (!headerSeen && /^\d+$/.test(line)) { report.header++; headerSeen = true; continue; }

    const stem = line.split('\t')[0].split('/')[0]; // flag'leri ve morfolojiyi at
    if (stem === '') continue;
    report.stems++;

    // hunspell özel işaretleri: koşullu ek kalıpları '(...)' vb.
    if (/[()]/.test(stem)) { report.specialMarked++; continue; }

    // özel isim / kısaltma: kökte büyük harf geçen girişleri at
    // (bu dic tamamen küçük harf ama kural pipeline'ın parçası — format değişirse guard)
    if ([...stem].some(isUpperTr)) { report.properNoun++; continue; }

    // Türkçe-aware normalize: İ→i, I→ı, â→a, î→i, û→u, ...
    const norm = turkceLower(stem);

    // format filtresi: yalnız [a-zçğıöşü], 3-6 harf
    if (!isGameWord(norm)) { report.regexFailed++; continue; }

    words.add(norm);
  }

  return { words, report };
}

// --- ana akış (top-level await) ---
try {
  const t0 = Date.now();
  const dicText = !force && existsSync(CACHE_PATH) ? readCachedDic() : await downloadDic();
  const { words, report } = parseDic(dicText);
  const sorted = [...words].sort(turkishCompare);

  console.log('── Rapor ────────────────────────────────');
  console.log(`  toplam satır            : ${report.totalLines}`);
  console.log(
    `  header/yorum/devam/boş  : ${report.header + report.comments + report.continuation + report.blank}`,
  );
  console.log(`  parse edilen stem       : ${report.stems}`);
  console.log(`  özel işaretli (atılan)  : ${report.specialMarked}`);
  console.log(`  özel isim (atılan)      : ${report.properNoun}`);
  console.log(`  regex dışı (atılan)     : ${report.regexFailed}`);
  console.log(`  FİLTRE SONRASI kelime   : ${sorted.length} (unique)`);

  if (sorted.length < MIN_WORDS) {
    console.error(`\nHATA: kelime sayısı ${sorted.length} < ${MIN_WORDS} (kalite guard) — exit 1`);
    process.exit(1);
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(sorted);
  writeFileSync(OUT_PATH, json, 'utf8');
  console.log(
    `✔ yazıldı: ${config.PATHS.WORDS} (${(json.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}sn)`,
  );
} catch (err) {
  console.error(`HATA: ${err.message}`);
  process.exit(1);
}
