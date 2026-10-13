// Smoke test: open a chart, screenshot, draw a trend line + horizontal line, screenshot again.
import { TradingView } from "../src/tradingview.js";

const tv = new TradingView();
try {
  await tv.open({ symbol: "BINANCE:BTCUSDT", interval: "1h" });
  console.log("symbol:", await tv.getSymbol());
  console.log("legend:", (await tv.readLegend()).slice(0, 200).replace(/\n/g, " | "));

  const before = await tv.screenshot();
  console.log("before:", before.file, `${before.width}x${before.height}`);

  const { width: w, height: h } = before;
  await tv.draw("trend_line", [
    { x: w * 0.3, y: h * 0.7 },
    { x: w * 0.7, y: h * 0.35 },
  ]);
  await tv.draw("horizontal_line", [{ x: w * 0.5, y: h * 0.5 }]);

  const after = await tv.screenshot();
  console.log("after:", after.file);
} finally {
  await tv.close();
}
