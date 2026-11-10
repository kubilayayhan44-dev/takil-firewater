#!/usr/bin/env node
// Offline puzzle havuzu üretimi (plan Task 3) → data/puzzles.json
// Her kayıt: { letters[], solutions[], seed, method, stats }
// Her puzzle generate() kabul kriterlerinden geçmiş + self-consistency doğrulanmış.
//
// Kullanım: node scripts/gen-puzzles.mjs [adet]   (default: config.PUZZLE.POOL_SIZE)

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../server/config.js';
import { loadDictionary } from '../server/dictionary.js';
import {
  generate,
  mulberry32,
  randomSeed,
  evaluateLetters,
  isAcceptable,
} from '../server/puzzle.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, config.PATHS.PUZZLES);

const target = Number(process.argv[2]) || config.PUZZLE.POOL_SIZE;
if (!Number.isFinite(target) || target < 1) {
  console.error('HATA: adet pozitif sayı olmalı');
  process.exit(1);
}

const { count } = loadDictionary();
console.log(`sözlük yüklendi: ${count} kelime`);

const puzzles = [];
const seen = new Set(); // harf-multiset dedupe (aynı set iki kez havuza girmesin)
let candidateRejects = 0; // generate() içindeki aday ret'leri (kriter tutmayan)
let dedupeRejects = 0; // üretilen ama kopya çıkan

while (puzzles.length < target) {
  const seed = randomSeed();
  const p = generate(mulberry32(seed), {
    onReject: () => candidateRejects++,
  });
  const key = [...p.letters].sort().join('');
  if (seen.has(key)) { dedupeRejects++; continue; }
  seen.add(key);
  puzzles.push({
    letters: p.letters,
    solutions: p.solutions,
    seed,
    method: p.method,
    stats: p.stats,
  });
}

// Self-consistency: letters ↔ solutions birebir eşleşmeli (plan kabul kriteri)
for (const p of puzzles) {
  const { solutions, stats } = evaluateLetters(p.letters);
  if (JSON.stringify(solutions) !== JSON.stringify(p.solutions) || !isAcceptable(stats)) {
    console.error('HATA: self-consistency bozuldu:', p.letters, 'seed:', p.seed);
    process.exit(1);
  }
}

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(puzzles, null, 1) + '\n', 'utf8');

const counts = puzzles.map((p) => p.stats.solutionCount);
const totalCandidates = target + dedupeRejects + candidateRejects;
const retRate = ((1 - target / totalCandidates) * 100).toFixed(1);
const avg = (counts.reduce((s, n) => s + n, 0) / counts.length).toFixed(1);

console.log('── Rapor ────────────────────────────────');
console.log(`✔ ${puzzles.length} puzzle → ${config.PATHS.PUZZLES}`);
console.log(`  aday ret oranı          : %${retRate} (${candidateRejects} ret / ${totalCandidates} aday)`);
console.log(`  dedupe ret              : ${dedupeRejects}`);
console.log(`  çözüm sayısı            : min ${Math.min(...counts)} / ort ${avg} / maks ${Math.max(...counts)}`);
const methods = puzzles.reduce((m, p) => ((m[p.method] = (m[p.method] ?? 0) + 1), m), {});
console.log(`  üretim yolları          : ${JSON.stringify(methods)}`);
