# tradingview-chart-mcp

MCP server that drives the real TradingView web chart through Chrome (Playwright), so an AI client can
look at charts, draw on them, switch symbols/timeframes, add indicators and receive alerts.

## Tools

| Tool | What it does |
|---|---|
| `tv_open` | Launch Chrome / open a chart (symbol, interval, or a saved layout URL) |
| `tv_set_symbol`, `tv_set_interval` | Change symbol / timeframe |
| `tv_screenshot` | Chart-pane PNG returned to the model + saved to `~/.tradingview-mcp/screenshots` |
| `tv_multi_timeframe` | Screenshots of one symbol across several timeframes (top-down analysis) |
| `tv_draw` | trend_line, horizontal_line, horizontal_ray, vertical_line, cross_line, fib_retracement (pixel coords from the last screenshot) |
| `tv_clear_drawings` | Remove all drawings |
| `tv_add_indicator` | Add an indicator by name |
| `tv_read_legend` | OHLC / indicator values from the legend |
| `tv_view` | zoom in/out, pan, reset |
| `tv_press`, `tv_click_text` | Escape hatches for anything else (Create Alert = `Alt+A`, menus, dialogs) |
| `tv_get_alerts` | Alerts received on the local webhook (`POST http://127.0.0.1:8787`) |

> Unofficial. Not affiliated with or endorsed by TradingView. It automates the TradingView web UI in your own
> browser session; make sure your use complies with TradingView's Terms of Use.

## Quick start

```bash
npx -y tradingview-chart-mcp          # stdio; add `-- --http` for Streamable HTTP
```

Requires Node 18+ and Google Chrome installed.

## Setup (from source)

```bash
npm install
npm run build
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": ["-y", "tradingview-chart-mcp"]
    }
  }
}
```

First run: call `tv_open`, then **log in to TradingView in the Chrome window that appears**. TradingView
blocks all drawing tools for anonymous users. The session persists in `~/.tradingview-mcp/profile`.

## Connecting AI clients

MCP is an open standard; the server speaks two transports.

**stdio (local clients)**: the client launches `node /abs/path/dist/index.js`.

| Client | Config |
|---|---|
| Claude Desktop, Cursor, Windsurf, Cline | `mcpServers` JSON (see Setup above) |
| Gemini CLI | `~/.gemini/settings.json` -> `"mcpServers": {"tradingview": {"command": "node", "args": ["/abs/path/dist/index.js"]}}` |
| OpenAI Codex CLI | `~/.codex/config.toml` -> `[mcp_servers.tradingview]` with `command = "node"`, `args = ["/abs/path/dist/index.js"]` |
| VS Code (Copilot) | `.vscode/mcp.json` -> `"servers": {"tradingview": {"command": "node", "args": [...]}}` |

**Streamable HTTP (remote / hosted clients such as ChatGPT)**:

```bash
TV_MCP_TOKEN=$(openssl rand -hex 24) npm run start -- --http     # http://127.0.0.1:3333/mcp
```

- `Authorization: Bearer <TV_MCP_TOKEN>` is required when the token is set (mandatory if `TV_MCP_HOST` is not loopback).
- Hosted clients cannot reach `127.0.0.1`; expose it through an HTTPS tunnel (cloudflared, ngrok) and give the client
  `https://<tunnel>/mcp`. In ChatGPT this is a custom connector (developer mode, availability depends on plan).
- **Security:** this endpoint controls your logged-in browser. Never expose it without the token, and prefer a
  tunnel with its own access control. Stateless mode: each request is independent, no sessions.
- `GET /health` for liveness. Env: `TV_MCP_PORT` (3333), `TV_MCP_HOST` (127.0.0.1), `TV_TRANSPORT=http` instead of `--http`.

## Use your already-open Chrome (no new browser, no tab switching)

```bash
bash node_modules/tradingview-chart-mcp/scripts/chrome-debug.sh   # or ./scripts/chrome-debug.sh from source; opens Chrome with --remote-debugging-port=9222; log in to TradingView once
```

The MCP then attaches over CDP, reuses the open `tradingview.com/chart` tab (or opens a new tab if none),
and works while that tab is in the background. If nothing is listening on the port, it launches its own Chrome.
`tv_open` reports `(attached)` or `(launched)`. Set `TV_ATTACH=0` to force launching, `TV_CDP_URL` to change the endpoint.

## Env vars

`TV_CHART_URL` (default saved layout), `TV_PROFILE_DIR`, `TV_SHOT_DIR`, `TV_HEADLESS=1`, `TV_WEBHOOK_PORT` (default 8787).

## Notes

- Uses Google Chrome installed on the machine (`channel: "chrome"`), no browser download.
- Automating the web UI is outside TradingView's official API; use it with your own account for personal use,
  and expect selectors to need occasional fixes when TradingView changes its UI.
- Verified without login: open, symbol/interval via URL, screenshot, legend, overlay dismissal.
  **Not yet verified (needs a logged-in session):** `tv_draw` hotkeys, `tv_add_indicator`, `tv_clear_drawings`.
