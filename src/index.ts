#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import crypto from "node:crypto";
import { z } from "zod";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DRAW_TOOLS, TradingView, type DrawTool } from "./tradingview.js";

const tv = new TradingView();

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
});
const run = async (fn: () => Promise<string>) => {
  try {
    return text(await fn());
  } catch (e) {
    return fail(e);
  }
};

// ---- alerts via webhook ---------------------------------------------------------

const ALERT_FILE = path.join(os.homedir(), ".tradingview-mcp", "alerts.jsonl");
const alerts: Array<{ receivedAt: string; body: unknown }> = [];
const WEBHOOK_PORT = Number(process.env.TV_WEBHOOK_PORT ?? 8787);

function startWebhook() {
  fs.mkdirSync(path.dirname(ALERT_FILE), { recursive: true });
  const srv = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200).end("tradingview-mcp webhook ok");
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* plain-text alert */
      }
      const entry = { receivedAt: new Date().toISOString(), body };
      alerts.push(entry);
      if (alerts.length > 500) alerts.shift();
      fs.appendFileSync(ALERT_FILE, JSON.stringify(entry) + "\n");
      res.writeHead(200).end("ok");
    });
  });
  srv.on("error", (e) => console.error(`[tradingview-mcp] webhook disabled: ${e.message}`));
  srv.listen(WEBHOOK_PORT, "127.0.0.1", () =>
    console.error(`[tradingview-mcp] alert webhook on http://127.0.0.1:${WEBHOOK_PORT}`),
  );
}

function registerTools(server: McpServer): void {
  // ---- chart control ---------------------------------------------------------

  server.tool(
    "tv_open",
    "Open the TradingView chart in the controlled browser. First call launches Chrome; log in once and the session persists.",
    {
      symbol: z.string().optional().describe("e.g. BINANCE:BTCUSDT, NASDAQ:AAPL, OANDA:XAUUSD"),
      interval: z.string().optional().describe("e.g. 1m, 5m, 15m, 1h, 4h, 1d, 1w"),
      url: z.string().url().optional().describe("Saved layout URL, e.g. https://www.tradingview.com/chart/AbCdEf12/"),
    },
    (a) => run(async () => (await tv.open(a), `Opened (${tv.mode}). Chart: ${await tv.getSymbol()}`)),
  );

  server.tool(
    "tv_set_symbol",
    "Change the chart symbol (keeps drawings/indicators on the current layout).",
    { symbol: z.string() },
    ({ symbol }) => run(async () => (await tv.setSymbol(symbol), `Symbol now: ${await tv.getSymbol()}`)),
  );

  server.tool(
    "tv_set_interval",
    "Change timeframe: 1m,5m,15m,30m,1h,4h,1d,1w,1mo.",
    { interval: z.string() },
    ({ interval }) => run(async () => (await tv.setInterval(interval), `Interval set to ${interval}`)),
  );

  server.tool(
    "tv_screenshot",
    "Screenshot the chart pane. Returns the image; pixel coordinates in the image are what tv_draw expects. Also saved to disk.",
    {},
    async () => {
      try {
        const { png, width, height, file } = await tv.screenshot();
        return {
          content: [
            { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
            { type: "text" as const, text: `Chart pane ${width}x${height}px. Saved: ${file}` },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "tv_multi_timeframe",
    "Screenshot the same symbol across several timeframes (top-down analysis). Restores nothing; the chart ends on the last interval.",
    {
      symbol: z.string().optional().describe("Optional; defaults to the current symbol"),
      intervals: z.array(z.string()).min(1).max(6).describe('e.g. ["1d","4h","1h","15m"]'),
    },
    async ({ symbol, intervals }) => {
      try {
        if (symbol) await tv.setSymbol(symbol);
        const content: Array<
          { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
        > = [];
        for (const interval of intervals) {
          await tv.setInterval(interval);
          const { png, file } = await tv.screenshot();
          content.push({ type: "text", text: `${await tv.getSymbol()} @ ${interval} (${file})` });
          content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        }
        return { content };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- drawing ----------------------------------------------------------------

  const point = z.object({ x: z.number(), y: z.number() });

  server.tool(
    "tv_draw",
    `Draw on the chart. Coordinates are pixels in the most recent tv_screenshot image (origin top-left). ` +
      `Tools: ${Object.keys(DRAW_TOOLS).join(", ")}. trend_line and fib_retracement need 2 points; the rest need 1.`,
    {
      tool: z.enum(Object.keys(DRAW_TOOLS) as [DrawTool, ...DrawTool[]]),
      points: z.array(point).min(1).max(3),
    },
    ({ tool, points }) => run(async () => (await tv.draw(tool, points), `Drew ${tool}. Take a tv_screenshot to verify.`)),
  );

  server.tool("tv_clear_drawings", "Remove all drawings from the chart.", {}, () =>
    run(async () => (await tv.clearDrawings(), "Cleared drawings.")),
  );

  server.tool(
    "tv_add_indicator",
    'Add an indicator by name, e.g. "RSI", "MACD", "Volume Profile Visible Range", "EMA".',
    { name: z.string() },
    ({ name }) => run(async () => (await tv.addIndicator(name), `Added indicator: ${name}`)),
  );

  // ---- reading & navigation -----------------------------------------------------

  server.tool(
    "tv_read_legend",
    "Read the chart legend: symbol, OHLC, volume and indicator values for the latest bar.",
    {},
    () => run(() => tv.readLegend()),
  );

  server.tool(
    "tv_view",
    "Navigate the chart view: zoom in/out, pan left/right, or reset.",
    {
      action: z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "reset"]),
      amount: z.number().int().min(1).max(100).optional().describe("zoom ticks or bars to pan (default 3 / 20)"),
    },
    ({ action, amount }) =>
      run(async () => {
        if (action === "zoom_in") await tv.zoom("in", amount ?? 3);
        else if (action === "zoom_out") await tv.zoom("out", amount ?? 3);
        else if (action === "pan_left") await tv.pan("left", amount ?? 20);
        else if (action === "pan_right") await tv.pan("right", amount ?? 20);
        else await tv.resetView();
        return `View: ${action}`;
      }),
  );

  server.tool(
    "tv_press",
    "Escape hatch: press a keyboard shortcut in the chart (e.g. Alt+A opens Create Alert, Alt+Shift+S snapshot).",
    { keys: z.string().describe("Playwright key syntax, e.g. Alt+A, Escape, Enter") },
    ({ keys }) => run(async () => (await tv.press(keys), `Pressed ${keys}`)),
  );

  server.tool(
    "tv_click_text",
    "Escape hatch: click the first visible element containing this text (menus, dialogs, buttons).",
    { text: z.string() },
    ({ text: t }) => run(async () => (await tv.clickText(t), `Clicked "${t}"`)),
  );

  server.tool(
    "tv_get_alerts",
    `Recent TradingView alerts received on the webhook (POST http://127.0.0.1:${WEBHOOK_PORT}; expose it with a tunnel such as cloudflared/ngrok).`,
    { limit: z.number().int().min(1).max(100).default(20) },
    ({ limit }) => run(async () => JSON.stringify(alerts.slice(-limit), null, 2) || "[]"),
  );

}

// ---- transports --------------------------------------------------------------------

function buildServer(): McpServer {
  const server = new McpServer({ name: "tradingview-mcp", version: "0.1.0" });
  registerTools(server);
  return server;
}

const wantHttp = process.argv.includes("--http") || process.env.TV_TRANSPORT === "http";

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

async function startHttp(): Promise<void> {
  const port = Number(process.env.TV_MCP_PORT ?? 3333);
  const host = process.env.TV_MCP_HOST ?? "127.0.0.1";
  const token = process.env.TV_MCP_TOKEN;
  if (host !== "127.0.0.1" && host !== "localhost" && !token) {
    throw new Error("TV_MCP_TOKEN is required when binding to a non-loopback host (this server controls your browser).");
  }
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") return void res.writeHead(200).end("ok");
    if (url.pathname !== "/mcp") return void res.writeHead(404).end("not found");
    if (token && !tokenOk(req.headers.authorization, token)) {
      return void res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("unauthorized");
    }
    if (req.method !== "POST") {
      // stateless mode: no server-initiated SSE stream
      return void res.writeHead(405, { Allow: "POST" }).end("method not allowed");
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return void res.writeHead(400).end("invalid JSON");
    }
    // Stateless: a fresh MCP server + transport per request, sharing the single browser controller.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, resolve);
  });
  console.error(`[tradingview-mcp] MCP over HTTP on http://${host}:${port}/mcp${token ? " (bearer token required)" : ""}`);
}

startWebhook();
if (wantHttp) await startHttp();
else await buildServer().connect(new StdioServerTransport());
process.on("SIGINT", async () => (await tv.close(), process.exit(0)));
process.on("SIGTERM", async () => (await tv.close(), process.exit(0)));
