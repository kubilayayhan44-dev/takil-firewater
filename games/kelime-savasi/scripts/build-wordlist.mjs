#!/usr/bin/env node
// Türkçe kelime listesi pipeline (plan Task 2 + genişletme):
//   Kaynak 1 — LibreOffice hunspell tr_TR.dic KÖKLERİ:
//     → indir (filesystem cache: data/raw/tr_TR.dic)
//     → hunspell stem parse ('/' sonrası flag'ler at, header satırı at)
//   Kaynak 2 — OpenSubtitles frekans listesi (EK ALMIŞ biçimler: 'şeyler', 'arabam'...):
//     → indir tr_50k.txt → adaylar HUNSPELL -G ile yazımsal doğrulamadan geçer
//     (frekans listesi altyazı kaynaklıdır — yanlış yazımlar hunspell filtresinde düşer)
//   → birleşim → Türkçe-aware normalize (server/turkce.js — ORTAK modül, kopya yok)
//     → filtre: /^[a-zçğıöşü]{3,6}$/, hunspell özel işaret/özel isim ayıklama
//     → dedupe + Türk alfabesi sıralaması → data/words.tr.json
//
// Not: unmunch (dic+aff tam türetme) DENEendi — tr_TR.aff ile bozuk üretim yapıyor
// ('aeminle' gibi sahteler, suffix buffer overflow). Bu yüzden doğrulamalı frekans yolu.
//
// Kullanım: node scripts/build-wordlist.mjs [--force]   (--force: cache'i yeniden indirir)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../server/config.js';
import { turkceLower, isGameWord, isUpperTr, turkishCompare } from '../server/turkce.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, config.PATHS.WORDS);
const CACHE_PATH = path.join(ROOT, config.PATHS.RAW_DIC_CACHE);
const DIC_URL =
  'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/tr_TR/tr_TR.dic';
const AFF_URL =
  'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/tr_TR/tr_TR.aff';
const FREQ_URL =
  'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/tr/tr_50k.txt';
const FREQ_CACHE_PATH = path.join(ROOT, 'data', 'raw', 'tr-freq-50k.txt');
const MIN_WORDS = 33_000; // kalite guard — altında exit 1 (kökler 32K + frekans eki, isim filtresi sonrası)

// Yaygın Türkçe özel isimler (altyazı frekans listesinde karakter adları olarak sık geçer;
// hunspell bunları kabul ettiğinden — ve ayrım flag'i yok — burada elle filtrelenir).
// Oyun harflerinden isim türetme zaten marjinal; liste bilinçli olarak en sık ~90 isim.
const PROPER_NAME_BLOCKLIST = new Set([
  // erkek
  'ahmet','mehmet','mustafa','ali','hasan','hüseyin','osman','yusuf','murat','ömer',
  'ramazan','halil','ibrahim','ismail','recep','kemal','kadir','serkan','burak','emre',
  'cem','can','deniz','emir','eren','ferhat','furkan','hakan','kaan','kerem',
  'kubilay','mahmut','mert','metin','nurettin','oktay','onur','orhan','polat','selim',
  'sinan','süleyman','şahin','tarık','tarkan','tolga','tolgay','volkan','yasin','yunus',
  'ziya','adem','bora','cemil','cevat','engin','erkan','ferhat','fikret','galip',
  // kadın
  'ayşe','fatma','zeynep','hatice','emine','elif','sultan','meryem','şerife','havva',
  'esra','selin','nazlı','leyla','nurten','sevgi','derya','gülşah','sibel','tülin',
  'cemre','ece','eda','elifnur','filiz','gül','hande','hilal','ipek','jasmin',
  'kader','kübra','melis','merve','nazan','neslihan','nilgün','nurcan','özlem','pelinsu',
  'pınar','serpil','sevda','sevim','şeyda','ülkü','yasemin','yeşim','yıldız','zehra',
]);

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

async function fetchTo(url, dest, label) {
  console.log(`⇣ indiriliyor: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} indirme başarısız: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, text, 'utf8');
  return text;
}

/**
 * Frekans listesi katmanı: aday kelimeleri hunspell -G ile doğrular.
 * hunspell yoksa katman sessizce atlanır (portability — CI gibi ortamlarda).
 * @returns {Set<string>} doğrulanmış + filtrelenmiş kelimeler (normalize edilmemiş ham hali değil —
 * burada normalize + isGameWord uygulanmış son hali döner)
 */
function frequencyLayer(rootSet) {
  const hunspellPath = spawnSync('which', ['hunspell']).stdout?.toString().trim();
  if (!hunspellPath || !existsSync(hunspellPath)) {
    console.log('⚠ hunspell bulunamadı — frekans katmanı ATLANDI (sadece kökler)');
    return { words: new Set(), stat: { candidates: 0, validated: 0 } };
  }

  const freqText = (existsSync(FREQ_CACHE_PATH) && !force)
    ? readFileSync(FREQ_CACHE_PATH, 'utf8')
    : fetchToSync(FREQ_URL, FREQ_CACHE_PATH, 'frekans listesi');
  // aff de lazım (hunspell -d tr_TR): cache yoksa indir — sync fetch yok, o yüzden önden indir
  const affPath = CACHE_PATH.replace(/\.dic$/, '.aff');
  if (!existsSync(affPath)) {
    console.log("⚠ tr_TR.aff cache yok — frekans katmanı ATLANDI (aff'ı indirmek için --force)");
    return { words: new Set(), stat: { candidates: 0, validated: 0 } };
  }

  const candidates = freqText
    .split('\n')
    .map((l) => l.split(' ')[0].trim())
    .filter(Boolean)
    .filter((w) => !PROPER_NAME_BLOCKLIST.has(w));

  const hun = spawnSync('hunspell', ['-d', 'tr_TR', '-m'], {
    input: candidates.join('\n'),
    cwd: path.dirname(CACHE_PATH), // tr_TR.dic + tr_TR.aff burada aranır
    maxBuffer: 64 * 1024 * 1024,
  });
  if (hun.status !== 0) {
    console.log('⚠ hunspell çalışmadı — frekans katmanı ATLANDI');
    return { words: new Set(), stat: { candidates: candidates.length, validated: 0 } };
  }

  // Morfoloji parse (\`-m\`): "kelime  st:stem fl:flag" satırları.
  // Kabul kuralı (özel isim/parazit filtresi — 'ahmet'→st:ahm gibi fragmentler düşer):
  //   a) stem kelimenin kendisine EŞİT (tam sözlük girişi: 'elma', 'evler', 'kediler')
  //   b) stem normalize edilmiş KÖK LİSTEMİZDE ve >=2 harf ('gittim'→st:git ✓)
  // Hunspell özel isim flag'i vermediğinden (tr_TR.aff sadece SFX) budur en sağlam ayıklayıcı.
  const words = new Set();
  let validated = 0;
  let currentWord = null;
  let currentOk = false;
  const flush = () => {
    if (currentWord !== null && currentOk) {
      const norm = turkceLower(currentWord);
      if (isGameWord(norm)) { validated++; words.add(norm); }
    }
    currentWord = null; currentOk = false;
  };
  for (const line of hun.stdout.toString().split('\n')) {
    if (line.trim() === '') { flush(); continue; }
    const cols = line.trim().split(/\s+/);
    const word = cols[0];
    const stem = line.match(/st:([^,\s]+)/)?.[1];
    if (word !== currentWord) { flush(); currentWord = word; }
    if (!stem) continue;
    if (stem === word) { currentOk = true; continue; }
    const stemNorm = turkceLower(stem);
    if (stemNorm.length >= 2 && rootSet.has(stemNorm)) currentOk = true;
  }
  flush();
  return { words, stat: { candidates: candidates.length, validated } };
}

/** sync indirme wrapper'ı (fetch async — process'i bloklamadan basit yol: execSync curl). */
function fetchToSync(url, dest, label) {
  const curl = spawnSync('curl', ['-sL', url, '-o', dest]);
  if (curl.status !== 0) throw new Error(`${label} indirme başarısız (curl)`);
  return readFileSync(dest, 'utf8');
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

  // frekans katmanı (ekli biçimler) — aff cache yoksa --force ile aff de indirilir
  if (force && !existsSync(CACHE_PATH.replace(/\.dic$/, '.aff'))) {
    await fetchTo(AFF_URL, CACHE_PATH.replace(/\.dic$/, '.aff'), 'tr_TR.aff');
  }
  const beforeFreq = words.size;
  const freq = frequencyLayer(words); // kök seti → stem kabul kuralı için
  for (const w of freq.words) words.add(w);

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
  console.log(`  kök FİLTRE SONRASI      : ${beforeFreq} (unique)`);
  console.log(`  frekans aday/doğrulanan : ${freq.stat.candidates} / ${freq.stat.validated}`);
  console.log(`  FİLTRE SONRASI kelime   : ${sorted.length} (unique, kök+frekans birleşim)`);

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
