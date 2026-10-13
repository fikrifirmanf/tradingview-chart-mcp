#!/usr/bin/env bash
# Start Chrome with a debug port so tradingview-mcp can attach to it (macOS).
# Chrome refuses the debug port on the default profile, so this uses its own profile dir;
# log in to TradingView in this window once and it stays logged in.
PORT="${TV_DEBUG_PORT:-9222}"
DIR="${TV_CHROME_DIR:-$HOME/.tradingview-mcp/chrome-debug}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
mkdir -p "$DIR"
nohup "$CHROME" --remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$DIR" "https://www.tradingview.com/chart/" >/dev/null 2>&1 &
echo "Chrome starting with debug port $PORT (profile: $DIR)"
