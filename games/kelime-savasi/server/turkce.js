// Türkçe-aware metin normalizasyonu — ORTAK modül.
// scripts/build-wordlist.mjs (offline pipeline) ile server runtime AYNI fonksiyonları
// kullanır; kopya implementasyon YASAK (drift riski).
//
// Kritik kural: toLocaleLowerCase('tr') TEK BAŞINA ASLA kullanılmaz —
// locale/ICU bağımlı davranış değişkendir. Harf-harf AÇIK map uygulanır:
//   İ→i, I→ı, Ç→ç, Ğ→ğ, Ö→ö, Ş→ş, Ü→ü, ASCII A-Z→a-z
// Uzun üye (circumflex) düzleştirilir: â→a, î→i, û→u (büyükleriyle birlikte).
// Harf çarkında ve kelime listesinde â/î/û/asla olmaz.

const CIRCUMFLEX = new Map([
  ['â', 'a'], ['Â', 'a'],
  ['î', 'i'], ['Î', 'i'],
  ['û', 'u'], ['Û', 'u'],
]);

const TR_UPPER_TO_LOWER = new Map([
  ['İ', 'i'], // noktalı büyük I → i
  ['I', 'ı'], // noktasız büyük I → ı
  ['Ç', 'ç'],
  ['Ğ', 'ğ'],
  ['Ö', 'ö'],
  ['Ş', 'ş'],
  ['Ü', 'ü'],
]);

/** Türkçe-aware küçük harfe çevir. Diğer karakterlere dokunmaz. */
export function turkceLower(word) {
  let out = '';
  for (const ch of String(word)) {
    if (CIRCUMFLEX.has(ch)) { out += CIRCUMFLEX.get(ch); continue; }
    if (TR_UPPER_TO_LOWER.has(ch)) { out += TR_UPPER_TO_LOWER.get(ch); continue; }
    out += /[A-Z]/.test(ch) ? ch.toLowerCase() : ch;
  }
  return out;
}

/** Karakter büyük harf mi? (Türkçe büyükleri + ASCII + circumflex büyükleri — küçük â/î/û HARİÇ) */
const CIRCUMFLEX_UPPER = new Set(['Â', 'Î', 'Û']);

export function isUpperTr(ch) {
  return TR_UPPER_TO_LOWER.has(ch) || CIRCUMFLEX_UPPER.has(ch) || /[A-Z]/.test(ch);
}

/** Oyun kelimesi formatı: yalnız [a-zçğıöşü], 3-6 harf. */
export const GAME_WORD_RE = /^[a-zçğıöşü]{3,6}$/;

export function isGameWord(word) {
  return GAME_WORD_RE.test(word);
}

// Türk alfabesi sıralaması — code-point sırası DEĞİL (ç/ğ/ı/ö/ş/ü yanlış yere düşer),
// Intl.Collator'a da güvenilmez (ICU verisi ortam değişkeni) → açık harf sırası.
const TR_ALPHABET = 'abcçdefgğhıijklmnoöprsştuüvyz';
const TR_ORDER = new Map([...TR_ALPHABET].map((ch, i) => [ch, i]));

/** Türk alfabesine göre deterministik karşılaştırma (Array#sort için). */
export function turkishCompare(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const oa = TR_ORDER.get(a[i]) ?? 99;
    const ob = TR_ORDER.get(b[i]) ?? 99;
    if (oa !== ob) return oa - ob;
  }
  return a.length - b.length;
}
