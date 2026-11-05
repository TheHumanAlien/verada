// Browser integration check against a built out/. Expects:
//   - a static server  (scripts/serve-static.mjs) at BASE_URLS (comma list, default root and a /bzz/<ref>/ subpath)
//   - an indexer API at INDEXER_URL (default http://127.0.0.1:42069), e.g. services/indexer/scripts/serve-fixtures.ts
// Needs playwright-core and a Chrome binary (CHROME_PATH). Not part of the default test run.
import { chromium } from "playwright-core";

const bases = (process.env.BASE_URLS ?? "http://127.0.0.1:8080/,http://127.0.0.1:8081/bzz/abc123def456/").split(",");
const indexerPort = new URL(process.env.INDEXER_URL ?? "http://127.0.0.1:42069").port;
const isIndexer = (u) => new URL(u).port === indexerPort;
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TOKEN = "0x00000000000000000000000000000000000000a1";
const pages = [
  ["", /Verada|Tokens|Launch/i],
  ["launch/", /launch/i],
  ["causes/", /cause/i],
  ["governance/", /governance|epoch/i],
  [`token/?address=${TOKEN}`, new RegExp(TOKEN.slice(0, 10), "i")],
  // Token page by ENS label (the ?label= override stands in for a <label>.varada.eth gateway host).
  ["?label=moon-cat", /moon-cat\.verada\.eth/i],
];

const browser = await chromium.launch({ executablePath: chrome, headless: true });
let failed = 0;
for (const base of bases) {
  for (const [path, expect] of pages) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const bad = [];
    const indexerCalls = [];
    page.on("response", (r) => {
      if (isIndexer(r.url())) indexerCalls.push(`${r.status()} ${new URL(r.url()).pathname}${r.headers()["access-control-allow-origin"] ? " [cors]" : ""}`);
      else if (!r.ok() && !r.url().endsWith("/favicon.ico") && r.url().startsWith(new URL(base).origin)) bad.push(`${r.status()} ${r.url()}`);
    });
    page.on("requestfailed", (r) => bad.push(`FAILED ${r.url()} ${r.failure()?.errorText}`));
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !m.location().url.endsWith("/favicon.ico") && errors.push(`console ${m.text()} ${m.location().url}`));
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const text = await page.locator("body").innerText();
    let extra = "";
    if (path === "causes/") {
      await page.getByRole("search").getByRole("textbox").fill("red cross");
      await page.getByRole("search").getByRole("button").click();
      await page.waitForTimeout(800);
      extra = (await page.locator("body").innerText()).includes("No results") ? " search=ok" : " search=NO-RESULT-TEXT";
      if (!extra.includes("ok")) bad.push("cause search did not render");
    }
    if (path === "") {
      // Cross-origin SSE and activity feed from the page origin.
      const sse = await page.evaluate(
        (url) =>
          new Promise((resolve) => {
            const es = new EventSource(`${url}/api/activity/stream`);
            const t = setTimeout(() => (es.close(), resolve("timeout")), 6000);
            es.onopen = () => (clearTimeout(t), es.close(), resolve("open"));
            es.onerror = () => (clearTimeout(t), es.close(), resolve("error"));
          }),
        `http://127.0.0.1:${indexerPort}`,
      );
      extra = ` sse=${sse}`;
      if (sse !== "open") bad.push(`sse ${sse}`);
    }
    const ok = expect.test(text) && bad.length === 0;
    if (!ok) failed++;
    if (!ok) failed += 0;
    console.log(`${ok ? "PASS" : "FAIL"} ${base}${path}  indexer calls: ${JSON.stringify(indexerCalls)}${extra}`);
    if (!ok || errors.length) console.log("   body:", text.slice(0, 200).replace(/\n/g, " | "), "\n   bad:", bad, "\n   errors:", errors.slice(0, 5));
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
