# Kelime Savaşı

1v1 gerçek zamanlı Türkçe kelime düellosu — harf çemberinden 3-6 harfli kelimeler türet,
90 saniyede rakibini geç. Takıl sunucusunda `games/kelime-savasi/` altında, kendi
Node servisi ile (port 8766) çalışır. Takıl'ın kendi dosyalarına (dev-server.js, deploy,
.github) **dokunmaz**.

## Yapı

```
games/kelime-savasi/
├── server/          # Express + Socket.IO + sözlük + puzzle
│   ├── config.js    # TÜM sabitler tek noktadan (PORT, süreler, kriterler)
│   ├── turkce.js    # Türkçe-aware normalize (İ→i, I→ı, â→a) — ortak modül
│   ├── dictionary.js# words.tr.json → Set + anagram index, validateWord()
│   ├── puzzle.js    # harf seti üretimi + çözüm hesabı + havuz
│   └── index.js     # HTTP + Socket.IO bootstrap
├── public/          # client (şimdilik placeholder)
├── scripts/
│   ├── build-wordlist.mjs  # tr_TR.dic → data/words.tr.json
│   └── gen-puzzles.mjs     # 150 doğrulanmış puzzle → data/puzzles.json
├── data/
│   ├── words.tr.json       # commit'lenir (~32K kelime)
│   ├── puzzles.json        # commit'lenir (150 puzzle)
│   └── raw/                # indirme cache'i (gitignore)
└── test/            # vitest
```

## Komutlar

```bash
npm install
npm run build:words    # data/words.tr.json üret (cache: data/raw/tr_TR.dic)
npm run gen:puzzles    # data/puzzles.json üret (150 puzzle)
npm test               # vitest
npm start              # http://127.0.0.1:8766/games/kelime-savasi
```

## API

- `GET /games/kelime-savasi/api/health` → `{ok:true, uptime, dict}`
- Socket.IO: `/games/kelime-savasi/socket.io` (şimdilik `echo` eventi; rooms/game Faz 2)

## Notlar

- Sözlük client'a **asla** gönderilmez — doğrulama tamamen server-side.
- Kelime kaynağı: LibreOffice hunspell `tr_TR.dic` (75.909 stem → ~32K oyun kelimesi).
- Faz 2: `server/rooms.js`, `server/game.js`, `server/scoring.js` eklenecek
  (plan: ~/plan.md Task 4-7).
