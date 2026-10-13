import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = path.join(os.homedir(), ".tradingview-mcp");
const PROFILE_DIR = process.env.TV_PROFILE_DIR ?? path.join(HOME, "profile");
export const SHOT_DIR = process.env.TV_SHOT_DIR ?? path.join(HOME, "screenshots");
const CHART_URL = process.env.TV_CHART_URL ?? "https://www.tradingview.com/chart/";
const HEADLESS = process.env.TV_HEADLESS === "1";

export const DRAW_TOOLS = {
  trend_line: { key: "Alt+T", clicks: 2 },
  horizontal_line: { key: "Alt+H", clicks: 1 },
  horizontal_ray: { key: "Alt+J", clicks: 1 },
  vertical_line: { key: "Alt+V", clicks: 1 },
  cross_line: { key: "Alt+C", clicks: 1 },
  fib_retracement: { key: "Alt+F", clicks: 2 },
} as const;
export type DrawTool = keyof typeof DRAW_TOOLS;

export interface Point {
  x: number;
  y: number;
}

/** "15m" | "1h" | "4h" | "1d" | "1w" -> TradingView interval token ("15", "60", "240", "D", "W") */
export function normalizeInterval(input: string): string {
  const s = input.trim().toLowerCase();
  const m = s.match(/^(\d+)\s*(s|m|h|d|w|mo)?$/);
  if (!m) return input.trim().toUpperCase();
  const n = Number(m[1]);
  switch (m[2]) {
    case "s":
      return `${n}S`;
    case "h":
      return String(n * 60);
    case "d":
      return n === 1 ? "D" : `${n}D`;
    case "w":
      return n === 1 ? "W" : `${n}W`;
    case "mo":
      return n === 1 ? "M" : `${n}M`;
    default:
      return String(n); // bare number or "m" = minutes
  }
}

export class TradingView {
  private ctx?: BrowserContext;
  private page?: Page;
  private browser?: Browser;
  private attached = false;

  /** Lazily launches Chrome with a persistent profile, so you only log in once. */
  async getPage(): Promise<Page> {
    const page = await this.ensurePage();
    if (!page.url().includes("tradingview.com/chart")) await this.open();
    return page;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.ctx) await this.attachOrLaunch();
    const ctx = this.ctx!;
    if (this.attached) {
      // Reuse the user's already-open TradingView chart tab; never hijack another tab.
      const existing = ctx.pages().find((p) => /tradingview\.com\/chart/.test(p.url()));
      this.page = existing ?? (await ctx.newPage());
      // Make the page behave as focused so hotkeys work while the tab stays in the background.
      const cdp = await ctx.newCDPSession(this.page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    } else {
      this.page = ctx.pages()[0] ?? (await ctx.newPage());
    }
    return this.page;
  }

  /** Prefer attaching to a running Chrome (remote debugging port); otherwise launch our own. */
  private async attachOrLaunch(): Promise<void> {
    if (process.env.TV_ATTACH !== "0") {
      const endpoint = process.env.TV_CDP_URL ?? "http://127.0.0.1:9222";
      try {
        this.browser = await chromium.connectOverCDP(endpoint, { timeout: 2_000 });
        this.ctx = this.browser.contexts()[0];
        this.attached = !!this.ctx;
        this.browser.on("disconnected", () => {
          this.browser = this.ctx = this.page = undefined;
          this.attached = false;
        });
      } catch {
        /* nothing listening: fall through to launching */
      }
    }
    if (this.ctx) return;
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: HEADLESS,
      viewport: { width: 1600, height: 900 },
    });
    this.ctx.on("close", () => {
      this.ctx = undefined;
      this.page = undefined;
    });
  }

  /** Navigate to a chart, optionally with symbol/interval (e.g. BINANCE:BTCUSDT, 60). */
  async open(opts: { symbol?: string; interval?: string; url?: string } = {}): Promise<void> {
    const page = await this.ensurePage();
    const url = new URL(opts.url ?? CHART_URL);
    if (opts.symbol) url.searchParams.set("symbol", opts.symbol);
    if (opts.interval) url.searchParams.set("interval", normalizeInterval(opts.interval));
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await this.waitForChart(page);
  }

  private async waitForChart(page: Page): Promise<void> {
    await page.waitForSelector("canvas", { timeout: 30_000 });
    await page.waitForTimeout(2_500); // let candles + legend render
    await this.dismissOverlays(page);
  }

  private async dismissOverlays(page: Page): Promise<void> {
    const labels = [/^accept all/i, /^got it/i, /^not now/i, /^maybe later/i, /^no thanks/i];
    for (let round = 0; round < 3; round++) {
      let clicked = false;
      for (const name of labels) {
        const btn = page.getByRole("button", { name }).first();
        if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
          await btn.click({ timeout: 1_000 }).catch(() => {});
          clicked = true;
        }
      }
      if (!clicked) break;
      await page.waitForTimeout(300);
    }
  }

  /** Anonymous sessions get a "Join for free" modal the moment a drawing tool is used. */
  private async failIfLoginWall(page: Page): Promise<void> {
    const wall = page.getByText(/unlock all drawings|join for free/i).first();
    if (await wall.isVisible({ timeout: 600 }).catch(() => false)) {
      await page.keyboard.press("Escape");
      await page.locator('[role="dialog"] button[aria-label="Close"], button[data-name="close"]').first().click({ timeout: 800 }).catch(() => {});
      throw new Error(
        "TradingView requires a login to use drawing tools. Switch to the Chrome window opened by tv_open, sign in once (the session is saved in the profile), then retry.",
      );
    }
  }

  /** Bounding box of the chart pane. Screenshot pixels and draw coordinates are relative to this. */
  async chartBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
    for (const sel of [".chart-gui-wrapper", ".layout__area--center", ".chart-container"]) {
      const box = await page.locator(sel).first().boundingBox().catch(() => null);
      if (box && box.width > 200 && box.height > 150) return box;
    }
    const vp = page.viewportSize() ?? { width: 1600, height: 900 };
    return { x: 0, y: 0, width: vp.width, height: vp.height };
  }

  async screenshot(opts: { save?: boolean } = {}): Promise<{ png: Buffer; width: number; height: number; file?: string }> {
    const page = await this.getPage();
    await page.mouse.move(0, 0); // keep the crosshair/tooltips out of the shot
    const box = await this.chartBox(page);
    const png = await page.screenshot({ clip: box });
    let file: string | undefined;
    if (opts.save !== false) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const sym = (await this.getSymbol()).replace(/[^\w-]+/g, "_") || "chart";
      file = path.join(SHOT_DIR, `${sym}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      fs.writeFileSync(file, png);
    }
    return { png, width: Math.round(box.width), height: Math.round(box.height), file };
  }

  async getSymbol(): Promise<string> {
    const page = await this.getPage();
    const title = await page.title();
    return title.split(/\s+/)[0] ?? "";
  }

  async setSymbol(symbol: string): Promise<void> {
    const page = await this.getPage();
    await this.focusChart(page);
    await page.keyboard.type(symbol, { delay: 40 });
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2_000);
  }

  async setInterval(interval: string): Promise<void> {
    const page = await this.getPage();
    await this.focusChart(page);
    await page.keyboard.type(normalizeInterval(interval), { delay: 40 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_500);
  }

  private async focusChart(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    const box = await this.chartBox(page);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.keyboard.press("Escape");
  }

  async draw(tool: DrawTool, points: Point[]): Promise<void> {
    const spec = DRAW_TOOLS[tool];
    if (points.length < spec.clicks) throw new Error(`${tool} needs ${spec.clicks} point(s)`);
    const page = await this.getPage();
    await this.dismissOverlays(page);
    const box = await this.chartBox(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press(spec.key);
    for (const pt of points.slice(0, spec.clicks)) {
      await page.mouse.move(box.x + pt.x, box.y + pt.y, { steps: 8 });
      await page.mouse.click(box.x + pt.x, box.y + pt.y);
      await page.waitForTimeout(150);
      await this.failIfLoginWall(page);
    }
    await page.keyboard.press("Escape");
  }

  async clearDrawings(): Promise<void> {
    const page = await this.getPage();
    const btn = page.locator('[data-name="removeAllDrawingTools"]').first();
    if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await btn.click();
      return;
    }
    // Fallback: the "Remove objects" flyout button's tooltip text
    await page.getByRole("button", { name: /remove objects|remove drawings/i }).first().click({ timeout: 2_000 });
  }

  async addIndicator(name: string): Promise<void> {
    const page = await this.getPage();
    await page.keyboard.press("Escape");
    await page.locator("#header-toolbar-indicators button, button[aria-label='Indicators, metrics, and strategies']").first().click();
    const search = page.locator('[data-name="indicators-dialog"] input, input[data-role="search"]').first();
    await search.waitFor({ timeout: 5_000 });
    await search.fill(name);
    await page.waitForTimeout(1_200);
    await page.locator('[data-role="list-item"], [data-name="indicators-dialog"] [class*="listContainer"] > div').first().click();
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
  }

  /** OHLC + indicator values as shown in the chart legend. */
  async readLegend(): Promise<string> {
    const page = await this.getPage();
    const legend = page.locator('[data-name="legend"]').first();
    if (await legend.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return (await legend.innerText()).trim();
    }
    return await page.title();
  }

  async resetView(): Promise<void> {
    const page = await this.getPage();
    await this.focusChart(page);
    await page.keyboard.press("Alt+R");
  }

  async zoom(direction: "in" | "out", amount = 3): Promise<void> {
    const page = await this.getPage();
    const box = await this.chartBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < amount; i++) {
      await page.mouse.wheel(0, direction === "in" ? -300 : 300);
      await page.waitForTimeout(80);
    }
  }

  async pan(direction: "left" | "right", bars = 20): Promise<void> {
    const page = await this.getPage();
    await this.focusChart(page);
    await page.keyboard.press(direction === "left" ? "ArrowLeft" : "ArrowRight", { delay: 0 });
    for (let i = 1; i < bars; i++) await page.keyboard.press(direction === "left" ? "ArrowLeft" : "ArrowRight");
  }

  async press(keys: string): Promise<void> {
    const page = await this.getPage();
    await page.keyboard.press(keys);
  }

  async clickText(text: string): Promise<void> {
    const page = await this.getPage();
    await page.getByText(text, { exact: false }).first().click({ timeout: 5_000 });
  }

  get mode(): "attached" | "launched" | "idle" {
    return this.attached ? "attached" : this.ctx ? "launched" : "idle";
  }

  async close(): Promise<void> {
    // Attached: only disconnect, never close the user's browser.
    if (this.attached) await this.browser?.close().catch(() => {});
    else await this.ctx?.close().catch(() => {});
  }
}
