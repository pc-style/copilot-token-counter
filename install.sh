#!/usr/bin/env sh
# copilot-token-counter installer
# Usage: curl -fsSL https://raw.githubusercontent.com/pc-style/copilot-token-counter/main/install.sh | sh
set -e

REPO="https://github.com/pc-style/copilot-token-counter.git"
DIR="${COPILOT_TOKEN_COUNTER_DIR:-$HOME/.copilot-token-counter}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required. Install it from https://bun.sh and re-run." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required." >&2
  exit 1
fi

# Remove old installation to ensure clean update
if [ -d "$DIR" ]; then
  echo ">> removing old installation"
  rm -rf "$DIR"
fi

echo ">> cloning into $DIR"
git clone --depth 1 "$REPO" "$DIR"

echo ">> installing dependencies"
( cd "$DIR" && bun install --silent )

mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/copilot-tokens"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env sh
exec bun run "$DIR/index.ts" "\$@"
EOF
chmod +x "$LAUNCHER"

echo
echo "installed: $LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "run: copilot-tokens" ;;
  *) echo "add to PATH:  export PATH=\"$BIN_DIR:\$PATH\""
     echo "then run:    copilot-tokens" ;;
esac
