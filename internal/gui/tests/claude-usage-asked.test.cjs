// Run with Node's test runner and Playwright on the module path; see README.md.
// A Claude account's usage is read only when the reader asks (the user:
// 不要伪造任何的 Claude 请求，能否通过 claude cli 获取): magpie runs Claude
// Code's own /usage, and only when the Usage page is opened or Refresh is
// pressed. Opening the page and Refresh (the header's, which on the Overview
// is the allowances' too, #486) load usage/quotas?asked=1; the
// window coming back to the front and the timed reload load it without; an
// asked load isn't swallowed by an unasked one already on its way, it goes
// after it. Chromium and WebKit; no backend, the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

function serve(asks, hold, quotas = [{ provider: "claude", name: "Claude", user: "a@example.com", windows: [{ name: "5 hours", used: 13 }] }], lang = "en") {
  return async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/usage/quotas") {
      asks.push(url.search);
      if (hold.on) await new Promise((r) => (hold.release = r));
      return json(quotas);
    }
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: an expired Claude snapshot is dated, then replaced on recovery`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const quota = { provider: "claude", name: "Claude", user: "a@example.com",
        asOf: new Date(Date.now() - 72e5).toISOString(),
        windows: [{ name: "5 hours", used: 100, resetsAt: new Date(Date.now() - 36e5).toISOString() }] };
      await page.route("**/*", serve([], { on: false }, [quota], lang));
      await page.goto("http://magpie.test/?view=usage");
      const card = page.locator(".subscription-card");
      const reading = card.locator(".quota-read");
      await reading.waitFor();
      assert.match(await reading.innerText(), lang === "en" ? /As of .*expired.*unknown/ : /截至 .*已过期.*未知/);
      assert.match(await card.locator(".quota-n").innerText(), /100%/);
      delete quota.asOf;
      quota.windows[0].used = 25;
      quota.windows[0].resetsAt = new Date(Date.now() + 36e5).toISOString();
      await page.locator("#usageReload").click();
      await page.waitForFunction(() => document.querySelector(".subscription-card .quota-n")?.textContent.includes("25%"));
      assert.equal(await reading.count(), 0, "a new reading clears the snapshot warning");
      assert.deepEqual(errors, []);
    });
  }
  test(`${engine}: Claude's usage is asked for only on opening Usage or Refresh`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const asks = [], hold = { on: false };
    await page.route("**/*", serve(asks, hold));
    const asked = () => asks.filter((s) => s === "?asked=1").length;
    const settle = async (n) => { for (let i = 0; i < 100 && asks.length < n; i++) await page.waitForTimeout(20); await page.waitForTimeout(150); };

    // opening the page asks
    await page.goto("http://magpie.test/?view=usage");
    await page.locator("#usageReload").waitFor();
    await settle(1);
    assert.equal(asked(), 1, `opening Usage asks once: ${JSON.stringify(asks)}`);

    // the window coming back to the front reads what is kept, asking nothing
    let n = asks.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await settle(n + 1);
    assert.equal(asked(), 1, `focus must not ask: ${JSON.stringify(asks)}`);
    // the timed reload is loadQuotas() with nothing
    n = asks.length;
    await page.evaluate(() => loadQuotas());
    await settle(n + 1);
    assert.equal(asked(), 1, `a timed reload must not ask: ${JSON.stringify(asks)}`);

    // Refresh asks
    await page.locator("#usageReload").click();
    await settle(asks.length + 1);
    assert.equal(asked(), 2, `Refresh asks: ${JSON.stringify(asks)}`);

    // an unasked load on its way doesn't swallow Refresh: it goes after it
    hold.on = true;
    n = asks.length;
    await page.evaluate(() => { loadQuotas(); });
    for (let i = 0; i < 100 && !hold.release; i++) await page.waitForTimeout(20);
    await page.locator("#usageReload").click();
    hold.on = false;
    hold.release();
    await settle(n + 2);
    assert.deepEqual(asks.slice(n), ["", "?asked=1"], "Refresh went after the load on its way");
    assert.deepEqual(errors, []);
  });
}
