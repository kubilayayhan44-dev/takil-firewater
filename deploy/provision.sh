#!/usr/bin/env bash
# =====================================================================
# Takıl — sunucu provisioning (idempotent)
# =====================================================================
# /opt/takil-app/deploy/ altından çalışır, deploy.yml tarafından SSH ile tetiklenir.
#
# Yaptıkları:
#   1) takil-worldly.service systemd unit'ini kurar/yeniler + restart
#   2) Caddyfile'a /api/worldly/* route'unu ekler
#   3) Kelime Savaşı (games/kelime-savasi) node bağımlılıklarını kurar (npm ci)
#   4) kelime-savasi.service systemd unit'ini kurar/yeniler + restart
#   5) Caddyfile'a /games/kelime-savasi/* route'unu ekler
#
# Her Caddy bölümü: idempotent + backup + caddy validate + reload;
# validate düşerse ROLLBACK (mevcut Caddyfile'a dokunulmaz, site ayakta).
#
# ASLA dokunmaz: takil-backend.service, Express (127.0.0.1:3211), /opt/takil-backend
# Portlar: worldly 127.0.0.1:8765, kelime-savasi 127.0.0.1:8766, Express 127.0.0.1:3211
# =====================================================================
set -euo pipefail

APP_DIR=/opt/takil-app
UNIT_SRC="$APP_DIR/deploy/takil-worldly.service"
UNIT_DST=/etc/systemd/system/takil-worldly.service
CADDYFILE=/etc/caddy/Caddyfile

# Kelime Savaşı (games/ altında yeni oyun — takil-app ile aynı deploy pipeline)
KS_DIR="$APP_DIR/games/kelime-savasi"
KS_UNIT_SRC="$APP_DIR/deploy/kelime-savasi.service"
KS_UNIT_DST=/etc/systemd/system/kelime-savasi.service

# ---------------------------------------------------------------------
# 1) takil-worldly systemd unit kurulumu (idempotent — her seferinde overwrite)
# ---------------------------------------------------------------------
echo "==> [1/5] takil-worldly systemd unit kurulumu"
if [ ! -f "$UNIT_SRC" ]; then
  echo "    HATA: $UNIT_SRC bulunamadı (rsync 'deploy/' include etti mi?)" >&2
  exit 1
fi
install -m 0644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable takil-worldly >/dev/null 2>&1 || true
systemctl restart takil-worldly
sleep 2
if systemctl is-active --quiet takil-worldly; then
  echo "    ✅ takil-worldly aktif (127.0.0.1:8765)"
else
  # Service fail olsa bile devam et (plan gereği route zararsız, service
  # sonradan fix edilebilir). Status'u logla ama exit etme.
  echo "    ⚠️  takil-worldly aktif DEĞİL — status:" >&2
  systemctl --no-pager status takil-worldly --lines=20 || true
fi

# ---------------------------------------------------------------------
# 2) Caddy /api/worldly/* route (idempotent + backup + validate + rollback)
# ---------------------------------------------------------------------
echo "==> [2/5] Caddy /api/worldly/* route kontrolü"
if grep -q 'handle /api/worldly/' "$CADDYFILE"; then
  echo "    ℹ️  /api/worldly/* route zaten mevcut — atlanıyor (idempotent)"
else
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP="${CADDYFILE}.bak-${TS}"
  cp -a "$CADDYFILE" "$BACKUP"
  echo "    📦 Yedek alındı: $BACKUP"

  # Her 'handle /api/* {' satırından ÖNCE worldly block ekle.
  # Caddy handle'ları özelden genele eşler → /api/worldly/* önce gelmeli.
  # Hem nip.io hem :3210 block'undaki tüm eşleşmelere uygulanır.
  awk '
    /handle \/api\/\* \{/ {
      print "    handle /api/worldly/* {"
      print "        reverse_proxy 127.0.0.1:8765"
      print "    }"
    }
    { print }
  ' "$CADDYFILE" > "${CADDYFILE}.new"

  # Syntax doğrula. Geçmezse: .new'i sil, mevcut Caddyfile'a DOKUNMA, reload YAPMA, FAIL et.
  if caddy validate --config "${CADDYFILE}.new" --adapter caddyfile >/dev/null 2>&1; then
    mv "${CADDYFILE}.new" "$CADDYFILE"
    systemctl reload caddy
    echo "    ✅ /api/worldly/* route eklendi + caddy reload (kesinti yok)"
  else
    rm -f "${CADDYFILE}.new"
    echo "    ❌ 'caddy validate' BAŞARISIZ — değişiklik geri alındı (ROLLBACK)" >&2
    echo "       Mevcut Caddyfile DEĞİŞMEDİ, reload yapılmadı, site ayakta." >&2
    echo "       Yedek: $BACKUP" >&2
    # Doğrulama çıktısını teşhis için göster
    caddy validate --config "$CADDYFILE" --adapter caddyfile || true
    exit 1
  fi
fi

# ---------------------------------------------------------------------
# 3) Kelime Savaşı node bağımlılıkları (npm ci --omit=dev)
#    Yumuşak-skip felsefesi: games/ bu pipeline ile İLK kez transfer ediliyor;
#    klasör/package.json henüz yoksa ya da Node eskiyse kurulum atlanır,
#    worldly bölümleri yukarıda zaten tamamlandı → ana site etkilenmez.
# ---------------------------------------------------------------------
echo "==> [3/5] Kelime Savaşı node bağımlılıkları ($KS_DIR)"
KS_SKIP=0
if [ ! -f "$KS_DIR/package.json" ]; then
  echo "    ℹ️  $KS_DIR/package.json bulunamadı — oyun dosyaları henüz deploy edilmedi."
  echo "       Kelime Savaşı kurulumu atlandı (bir sonraki deploy'da otomatik denenir)."
  KS_SKIP=1
fi
if [ "$KS_SKIP" = "0" ]; then
  # Fail-fast sürüm kontrolü: Socket.IO/Express için Node >= 18 gerekli.
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "    ⚠️  Node sürümü eski ($(node -v 2>/dev/null || echo 'bilinmiyor')) — Kelime Savaşı için >=18 gerekli." >&2
    echo "       Kurulum atlandı; Node yükseltildikten sonra yeniden deploy edin." >&2
    KS_SKIP=1
  fi
fi
if [ "$KS_SKIP" = "0" ]; then
  if [ -f "$KS_DIR/package-lock.json" ]; then
    echo "    📦 npm ci --omit=dev (package-lock.json mevcut — deterministik)"
    if ! ( cd "$KS_DIR" && npm ci --omit=dev --no-audit --no-fund ); then
      echo "    ⚠️  npm ci başarısız — unit/route kurulmadı, sonraki deploy'da tekrar denenecek" >&2
      KS_SKIP=1
    fi
  else
    echo "    ⚠️  package-lock.json yok — npm install --omit=dev fallback (deterministik DEĞİL)"
    if ! ( cd "$KS_DIR" && npm install --omit=dev --no-audit --no-fund ); then
      echo "    ⚠️  npm install başarısız — unit/route kurulmadı" >&2
      KS_SKIP=1
    fi
  fi
fi

# ---------------------------------------------------------------------
# 4) kelime-savasi systemd unit kurulumu (worldly pattern'i — fail olsa da devam)
# ---------------------------------------------------------------------
echo "==> [4/5] kelime-savasi systemd unit kurulumu"
if [ "$KS_SKIP" = "1" ]; then
  echo "    ↩️  atlandı (bağımlılık kurulumu yapılamadı — [3/5]'e bak)"
elif [ ! -f "$KS_UNIT_SRC" ]; then
  echo "    ⚠️  $KS_UNIT_SRC bulunamadı (rsync 'deploy/' include etti mi?) — atlandı" >&2
else
  install -m 0644 "$KS_UNIT_SRC" "$KS_UNIT_DST"
  systemctl daemon-reload
  systemctl enable kelime-savasi >/dev/null 2>&1 || true
  systemctl restart kelime-savasi
  sleep 2
  if systemctl is-active --quiet kelime-savasi; then
    echo "    ✅ kelime-savasi aktif (127.0.0.1:8766)"
  else
    # Service fail olsa bile Caddy route eklemeye DEVAM et (route zararsız,
    # service sonradan fix edilebilir). Status'u logla ama exit etme.
    echo "    ⚠️  kelime-savasi aktif DEĞİL — status:" >&2
    systemctl --no-pager status kelime-savasi --lines=20 || true
  fi
fi

# ---------------------------------------------------------------------
# 5) Caddy /games/kelime-savasi/* route (worldly pattern'i birebir)
# ---------------------------------------------------------------------
echo "==> [5/5] Caddy /games/kelime-savasi/* route kontrolü"
if [ "$KS_SKIP" = "1" ]; then
  echo "    ↩️  atlandı (bağımlılık kurulumu yapılamadı — [3/5]'e bak)"
elif grep -q 'handle /games/kelime-savasi/' "$CADDYFILE"; then
  echo "    ℹ️  /games/kelime-savasi/* route zaten mevcut — atlanıyor (idempotent)"
else
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP="${CADDYFILE}.bak-${TS}"
  cp -a "$CADDYFILE" "$BACKUP"
  echo "    📦 Yedek alındı: $BACKUP"

  # Her 'handle /api/* {' satırından ÖNCE ekle. Böylece route worldly block'unun
  # hemen yanına (kapanışından sonra) ve genel 'handle /api/*' + file_server
  # catch-all'larından ÖNCE yerleşir — Caddy'de spesifik route'lar genelden
  # önce gelmek zorundadır (ilk match kazanır). /games/* prefix'i /api/* ile
  # çakışmasa da bu yerleşim her genel handle'a karşı güvenlidir.
  # Hem nip.io hem :3210 block'undaki tüm eşleşmelere uygulanır (worldly gibi).
  awk '
    /handle \/api\/\* \{/ {
      print "    handle /games/kelime-savasi/* {"
      print "        reverse_proxy 127.0.0.1:8766"
      print "    }"
    }
    { print }
  ' "$CADDYFILE" > "${CADDYFILE}.new"

  # Syntax doğrula. Geçmezse: .new'i sil, mevcut Caddyfile'a DOKUNMA, reload YAPMA, FAIL et.
  if caddy validate --config "${CADDYFILE}.new" --adapter caddyfile >/dev/null 2>&1; then
    mv "${CADDYFILE}.new" "$CADDYFILE"
    systemctl reload caddy
    echo "    ✅ /games/kelime-savasi/* route eklendi + caddy reload (kesinti yok)"
  else
    rm -f "${CADDYFILE}.new"
    echo "    ❌ 'caddy validate' BAŞARISIZ — değişiklik geri alındı (ROLLBACK)" >&2
    echo "       Mevcut Caddyfile DEĞİŞMEDİ, reload yapılmadı, site ayakta." >&2
    echo "       Yedek: $BACKUP" >&2
    # Doğrulama çıktısını teşhis için göster
    caddy validate --config "$CADDYFILE" --adapter caddyfile || true
    exit 1
  fi
fi

echo "==> ✅ Provisioning tamamlandı"
