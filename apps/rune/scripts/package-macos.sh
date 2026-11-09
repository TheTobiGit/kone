#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
RUNE_DIR="$ROOT/apps/rune"
BUN_BIN=${KONE_BUN_BIN:-$(command -v bun)}
ARCH=$(uname -m)
case "$ARCH" in arm64) PLATFORM=arm64 ;; x86_64) PLATFORM=x64 ;; *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; esac
NODE_VERSION=${KONE_NODE_VERSION:-25.9.0}
NODE_TMP=$(mktemp -d)
trap 'rm -rf "$NODE_TMP"' EXIT
NODE_ARCHIVE="node-v$NODE_VERSION-darwin-$PLATFORM.tar.gz"
curl --connect-timeout 20 --max-time 300 -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE" -o "$NODE_TMP/$NODE_ARCHIVE"
curl --connect-timeout 20 --max-time 300 -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt"
(cd "$NODE_TMP" && awk -v file="$NODE_ARCHIVE" '$2 == file { print }' SHASUMS256.txt > checksum.txt && test -s checksum.txt && shasum -a 256 -c checksum.txt)
tar -xzf "$NODE_TMP/$NODE_ARCHIVE" -C "$NODE_TMP"
NODE_BIN="$NODE_TMP/node-v$NODE_VERSION-darwin-$PLATFORM/bin/node"
"$BUN_BIN" run --cwd "$RUNE_DIR/sidecar" build
cargo build --manifest-path "$ROOT/Cargo.toml" -p kone-rune --release
APP="$RUNE_DIR/dist/Kone Rune.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/sidecar/node_modules/@anthropic-ai" "$APP/Contents/Resources/sidecar/node_modules/@ast-grep"
cp "$ROOT/target/release/kone-rune" "$APP/Contents/MacOS/kone-rune"
cp "$NODE_BIN" "$APP/Contents/Resources/node"
cp "$RUNE_DIR/sidecar/dist/"*.mjs "$APP/Contents/Resources/sidecar/"
SDK_ROOT=$(CDPATH= cd -- "$RUNE_DIR/sidecar/node_modules/@anthropic-ai/claude-agent-sdk" && pwd -P)
AST_ROOT=$(CDPATH= cd -- "$RUNE_DIR/sidecar/node_modules/@ast-grep/napi" && pwd -P)
cp -R "$SDK_ROOT" "$APP/Contents/Resources/sidecar/node_modules/@anthropic-ai/claude-agent-sdk"
cp -R "$(CDPATH= cd -- "$(dirname "$SDK_ROOT")/claude-agent-sdk-darwin-$PLATFORM" && pwd -P)" "$APP/Contents/Resources/sidecar/node_modules/@anthropic-ai/"
cp -R "$AST_ROOT" "$APP/Contents/Resources/sidecar/node_modules/@ast-grep/napi"
cp -R "$(CDPATH= cd -- "$(dirname "$AST_ROOT")/napi-darwin-$PLATFORM" && pwd -P)" "$APP/Contents/Resources/sidecar/node_modules/@ast-grep/"
cat > "$APP/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/sh
CONTENTS=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
export KONE_RUNE_SIDECAR_NODE="$CONTENTS/Resources/node"
export KONE_RUNE_SIDECAR_SCRIPT="$CONTENTS/Resources/sidecar/index.mjs"
exec "$CONTENTS/MacOS/kone-rune" "$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Kone Rune</string>
<key>CFBundleIdentifier</key><string>app.kone.rune</string>
<key>CFBundleExecutable</key><string>launch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
printf 'Packaged %s\n' "$APP"
