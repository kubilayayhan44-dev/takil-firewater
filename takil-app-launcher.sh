#!/bin/bash
LOG="$HOME/Library/Logs/Takil.log"
echo "=== $(date) ===" >> "$LOG"

PROJECT_DIR="$HOME/Desktop/Takil-FireWater"
PORT=8765
URL="http://localhost:$PORT"

# Node bul
NODE_BIN=""
for p in /opt/homebrew/bin/node /usr/local/bin/node $(ls $HOME/.nvm/versions/node/*/bin/node 2>/dev/null) /usr/bin/node; do
  [ -x "$p" ] && NODE_BIN="$p" && break
done

if [ -z "$NODE_BIN" ]; then
  echo "Node yok!" >> "$LOG"
  osascript -e 'display dialog "Node.js bulunamadı! Kurmak için: https://nodejs.org" buttons {"Tamam"} with icon stop' 2>/dev/null
  exit 1
fi
echo "Node: $NODE_BIN" >> "$LOG"

# Sunucu çalışıyor mu?
if ! lsof -ti :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Sunucu başlatılıyor..." >> "$LOG"
  cd "$PROJECT_DIR"
  nohup "$NODE_BIN" dev-server.js >> "$LOG" 2>&1 &
  # Sunucu hazır olana kadar bekle
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    if curl -s -o /dev/null -w "%{http_code}" "$URL/index.html" --max-time 2 2>/dev/null | grep -q "200"; then
      echo "Sunucu hazır ($i. denemede)" >> "$LOG"
      break
    fi
  done
else
  echo "Sunucu zaten çalışıyor" >> "$LOG"
fi

# Tunnel
TUNNEL_URL=""
if pgrep -f "cloudflared tunnel" >/dev/null; then
  for f in /tmp/cf-tunnel*.log; do
    [ -f "$f" ] || continue
    TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$f" | head -1)
    [ -n "$TUNNEL_URL" ] && break
  done
  echo "Tunnel çalışıyor: $TUNNEL_URL" >> "$LOG"
fi

if [ -z "$TUNNEL_URL" ] && [ -x "$HOME/bin/cloudflared" ]; then
  TUNNEL_LOG="/tmp/cf-tunnel-app.log"
  > "$TUNNEL_LOG"
  nohup "$HOME/bin/cloudflared" tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 1
    TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
    [ -n "$TUNNEL_URL" ] && break
  done
  echo "Yeni tunnel: $TUNNEL_URL" >> "$LOG"
fi

# Tarayıcı aç
TIMESTAMP=$(date +%s)
echo "Tarayıcı açılıyor..." >> "$LOG"
open "$URL/index.html?v=$TIMESTAMP"

# Tunnel URL'i panoya kopyala
if [ -n "$TUNNEL_URL" ]; then
  echo -n "$TUNNEL_URL" | pbcopy
  osascript -e "display notification \"Pano'da tunnel URL: $TUNNEL_URL\" with title \"🎮 Takıl Açıldı\" subtitle \"Lokal: $URL\" sound name \"Glass\"" 2>/dev/null
else
  osascript -e "display notification \"Lokal: $URL\" with title \"🎮 Takıl Açıldı\" sound name \"Glass\"" 2>/dev/null
fi

echo "✓ Tamamlandı: $(date)" >> "$LOG"
