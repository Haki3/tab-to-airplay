#!/bin/bash
# One-time installer for the native side of AirPlay Tab Caster.
#   1. Builds AirPlayCaster.app
#   2. Creates the native-messaging host launcher
#   3. Registers it with Chrome so the extension can reach it
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$ROOT/native"
EXT_ID="peikkecpbbkcopacloehlodpffhcjbhf"
HOST_NAME="com.reda.airplaycaster"

echo "════════════════════════════════════════════"
echo "  AirPlay Tab Caster — instalación nativa"
echo "════════════════════════════════════════════"

# 1. Build the app -----------------------------------------------------------
bash "$NATIVE/build.sh"

# 2. Resolve python3 and write the host launcher -----------------------------
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "✗ No encuentro python3. Instálalo (xcode-select --install o Homebrew) y reintenta."
  exit 1
fi

LAUNCHER="$NATIVE/airplay-host"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
exec "$PY" "$NATIVE/airplay_host.py" "\$@"
EOF
chmod +x "$LAUNCHER"
chmod +x "$NATIVE/airplay_host.py"
echo "✓ Host launcher: $LAUNCHER  (python: $PY)"

# 3. Register the native-messaging host with Chrome --------------------------
# Covers Chrome stable + Chrome Beta/Canary + Chromium if present.
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "AirPlay Tab Caster native helper",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
)

installed_any=0
for DIR in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"; do
  PARENT="$(dirname "$DIR")"
  if [ -d "$PARENT" ]; then
    mkdir -p "$DIR"
    printf '%s\n' "$MANIFEST_JSON" > "$DIR/$HOST_NAME.json"
    echo "✓ Registrado en: $DIR/$HOST_NAME.json"
    installed_any=1
  fi
done

if [ "$installed_any" -eq 0 ]; then
  echo "⚠ No detecté un perfil de Chrome/Chromium. ¿Está instalado?"
fi

echo ""
echo "──────────────────────────────────────────────"
echo "Falta solo cargar la extensión en Chrome:"
echo "  1. Abre  chrome://extensions"
echo "  2. Activa 'Modo de desarrollador' (arriba a la derecha)"
echo "  3. 'Cargar descomprimida' → elige:"
echo "       $ROOT/extension"
echo "  4. El ID debe ser: $EXT_ID"
echo "──────────────────────────────────────────────"
echo "Listo ✅  Abre un video, pulsa el botón 📺 y elige tu TV."
