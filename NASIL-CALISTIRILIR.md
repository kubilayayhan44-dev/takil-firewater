# 🎮 Takıl — Lokal Geliştirme Sunucusu

## ⚡ Hızlı Başlangıç

Terminal'de bu klasöre git ve şunu yaz:

```bash
node dev-server.js
```

Sonra tarayıcıda aç: **http://localhost:8765**

## 🔧 Nasıl Çalışıyor?

```
┌─────────────────────────────────┐
│  Tarayıcı (localhost:8765)      │
└────────────┬────────────────────┘
             │
        Dev Server (Node.js)
             │
    ┌────────┴───────────┐
    ▼                    ▼
┌──────────┐    ┌─────────────────┐
│ index.html│    │ Canlı VPS API   │
│ (lokal)   │    │ 178-105-90-130  │
│ — yeni    │    │ — gerçek backend│
│ değişikler│    │ — demo hesaplar │
└──────────┘    └─────────────────┘
```

- ✅ **HTML/JS** lokalden gelir (senin yeni değişikliklerin)
- ✅ **`/api/*`** istekleri canlı VPS'e gider (login, register, vs.)
- ✅ Demo hesaplarla giriş yapabilirsin

## 👤 Demo Hesaplar

| E-posta | Şifre |
|---------|-------|
| `kubilay@takil.app` | `kubilay123` |
| `avukat@takil.app` | `avukat123` |
| `kullanici1@takil.app` | `kullanici1` |
| `kullanici2@takil.app` | `kullanici2` |

## ⏹ Durdurmak için

Terminal'de **Ctrl+C** veya:

```bash
pkill -f "node dev-server.js"
```

## 🚀 Canlı VPS'e Yükleme

Yeni değişiklikleri canlıya almak için:

```bash
scp index.html root@178.105.90.130:/var/www/takil/
```

(SSH erişimin yoksa söyle, deploy yöntemini birlikte düşünelim)

## ❓ Sorun mu var?

- **Port 8765 dolu hatası**: `lsof -i :8765` ile bak, sonra `kill -9 PID`
- **API hatası**: VPS canlı mı kontrol et → https://178-105-90-130.nip.io
- **Node.js yok**: `brew install node` (Mac için)
