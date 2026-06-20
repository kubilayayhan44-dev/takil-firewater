#!/usr/bin/env bash
# =====================================================================
# Takıl Worldly — sunucu provisioning (idempotent)
# =====================================================================
# /opt/takil-app/deploy/ altından çalışır, deploy.yml tarafından SSH ile tetiklenir.
#
# Yaptıkları:
#   1) takil-worldly.service systemd unit'ini kurar/yeniler + restart
#   2) Caddyfile'a /api/worldly/* route'unu ekler
#      (idempotent + backup + caddy validate + reload; validate düşerse ROLLBACK)
#
# ASLA dokunmaz: takil-backend.service, Express (127.0.0.1:3211), /opt/takil-backend
# Worldly portu 127.0.0.1:8765 — Express (3211) ile çakışmaz.
# =====================================================================
set -euo pipefail

APP_DIR=/opt/takil-app
UNIT_SRC="$APP_DIR/deploy/takil-worldly.service"
UNIT_DST=/etc/systemd/system/takil-worldly.service
CADDYFILE=/etc/caddy/Caddyfile

# ---------------------------------------------------------------------
# 1) systemd unit kurulumu (idempotent — her seferinde overwrite)
# ---------------------------------------------------------------------
echo "==> [1/3] takil-worldly systemd unit kurulumu"
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
  # Service fail olsa bile Caddy route'u eklemeye DEVAM et (plan gereği route zararsız,
  # service sonradan fix edilebilir). Status'u logla ama exit etme.
  echo "    ⚠️  takil-worldly aktif DEĞİL — status:" >&2
  systemctl --no-pager status takil-worldly --lines=20 || true
fi

# ---------------------------------------------------------------------
# 2) Caddy route ekleme (idempotent + backup + validate + rollback)
# ---------------------------------------------------------------------
echo "==> [2/3] Caddy /api/worldly/* route kontrolü"
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

echo "==> [3/3] Provisioning tamamlandı ✅"
