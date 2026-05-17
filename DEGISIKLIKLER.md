# Takıl — Ateş & Su Tarzı Macera Modu Güncellemesi

## 🔥💧 Yapılan Değişiklikler

### Yeni: 5 Farklı Sahne Tipi
Her bölüm `lvl % 5` ile değişen sahne tipinde geçer:

| # | Sahne | İkon | Mekanikler |
|---|-------|------|-----------|
| 1 | 🏰 Şato Salonu | castle | Basınç plakası + köprü açma |
| 2 | 🌋 Lav Mağarası | lava_cave | Çok ateş havuzu + sıçrama padleri |
| 3 | ❄️ Buz Sarayı | ice_palace | Kaygan platformlar (slip fiziği) |
| 4 | 🏛️ Tapınak | temple_puzzle | İtilebilir kutular + eleman küreleri |
| 5 | 🌌 Uzay Boşluğu | space_jump | Küçük platformlar + zıplama padleri |

### Yeni Mekanikler
1. **Parçalı zemin + havuzlar** — Ateş&Su tarzı, segmentler arası tehlike
2. **Slippery (kaygan) platformlar** — buz sahnelerinde sürtünme düşer
3. **Basınç plakası → köprü açma** — bağlama mantığı bug'ı düzeltildi
4. **Elmas toplama** — her 5 bölümde bonus, mor parıldayan elmas
5. **Sahne intro hint metni** — sahne tipine göre yönlendirme

### Karakterler (mevcut)
| Karakter | İkon | Zayıf olduğu hazard |
|----------|------|---------------------|
| Alev | 🔥 | Su (mavi havuz) |
| Damla | 💧 | Ateş (kırmızı havuz) |
| Yıldırım | ⚡ | Su (iletken) |
| Kar | ❄️ | Ateş + Güneş ışını |

### Telif Önlemi 🛡️
- Karakter isimleri **kendi** (Alev/Damla/Yıldırım/Kar)
- 4 element sistemi (Ateş&Su sadece 2)
- 5 farklı sahne tipi (orijinalde yok)
- Kendi tema/renk paleti
- Türkçe arayüz

---

## 🚀 VPS'e Deploy

Mevcut canlı site: `https://178-105-90-130.nip.io`

### Manuel upload (SSH):
```bash
# Yerel: index.html'i yükle
scp ~/Desktop/Takil-FireWater/index.html root@178.105.90.130:/var/www/takil/

# VPS'te nginx reload (gerekli değil, statik dosya)
ssh root@178.105.90.130 "ls -lh /var/www/takil/index.html"
```

### Veya web panelinden:
Hangi servisi kullandıysan (Caddy / Nginx / direkt) → `index.html` dosyasını upload et.

---

## 🧪 Lokal Test

Şu an çalışan: `http://localhost:8765/index.html`

Kapatmak için:
```bash
pkill -f "python3 -m http.server 8765"
```
