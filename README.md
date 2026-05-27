# 🔥💧 Takıl

**Fireboy & Watergirl** tarzı kooperatif puzzle/platform oyunu. 2-4 oyunculu, 100 bölüm, 8 farklı dünya.

🎮 **Oyna**: [https://178-105-90-130.nip.io](https://178-105-90-130.nip.io)

---

## ✨ Özellikler

- 🎯 **100 profesyonel bölüm** — Python validator ile playability garantili (BFS path doğrulanmış)
- 🌍 **8 tematik dünya**: Antik, Donmuş, Yanardağ, Lab, Gökyüzü, Maden, Siber, Cangıl
- 👥 **Dinamik 2/3/4 oyuncu desteği** — eksik kapılar otomatik eklenir
- ✨ **Premium görsel atmosfer** — toz, kar, kıvılcım, bulut, devre, yaprak partikülleri
- 🎨 **Premium mekanik tasarımları**: Asansör, Trambolin, Lazer, Portal, Fan, Kutu, Düğme
- 🚪 **Kemerli kapılar** — gradient + ahşap doku + altın tokmak + glow halo
- 🎵 **Soundtouch.js** profesyonel pitch+tempo engine
- 📱 **Touch + klavye + gamepad** desteği

---

## 🚀 Geliştirme

### Local'de Aç

```bash
git clone https://github.com/kubilayayhan44-dev/takil-firewater.git
cd takil-firewater

# Basit dev server (Node.js)
node dev-server.js

# Veya direkt index.html'i tarayıcıda aç
open index.html
```

### Auto-Deploy

`main` branch'e push edince **otomatik** olarak Hetzner sunucusuna deploy edilir:

```
git push origin main
   ↓
GitHub Actions (~30 saniye)
   ↓
https://178-105-90-130.nip.io
```

### Workflow Kuralı

Çakışma olmaması için push'tan **önce** her zaman:

```bash
git pull --rebase origin main
git push origin main
```

---

## 👥 Geliştiriciler

- 🧑 [Kubilay](https://github.com/kubilayayhan44-dev)
- 🧑‍🎨 [Hediye](https://github.com/hediyebayer)

Pi (AI coding agent) destekli geliştirme 🤖

---

## 📂 Dosya Yapısı

```
takil-firewater/
├── index.html              # Ana oyun (23K satır, vanilla HTML+JS+CSS)
├── og-image.png            # Social share görseli
├── vendor/                 # 3rd party JS (Soundtouch.js)
├── dev-server.js           # Local dev için basit Node server
├── takil-app-launcher.sh   # macOS uygulaması olarak başlatıcı
├── .github/workflows/      # GitHub Actions auto-deploy
└── NASIL-CALISTIRILIR.md   # Kullanım dökümanı (TR)
```

---

## 🛠️ Tech Stack

- **Vanilla HTML5 + CSS3 + JavaScript** (no framework)
- **Canvas API** (oyun render)
- **Soundtouch.js** (ses engine)
- **Hetzner VPS** (host)
- **GitHub Actions** (CI/CD)
- **Nginx** (reverse proxy + SSL via Let's Encrypt + nip.io)

---

Made with ❤️ in Türkiye
