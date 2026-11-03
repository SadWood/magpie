// Run with Node's test runner and Playwright on the module path; see README.md.
// Hold a model save until another picker is open. Its reply rebuilds the
// agent rows: the picker must keep its current entry, field and interaction
// state, rather than positioning a submenu against a detached button at 0,0.
// Every API is intercepted; no real agent config or network is used.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const models = ["Alpha", "Beta", "Gamma"].map((label) => ({ value: "magpie/test/" + label.toLowerCase(), label, ref: "test/" + label.toLowerCase(), group: "Test" }));
models.push(...Array.from({ length: 18 }, (_, i) => ({ value: "magpie/test/extra-" + i, label: "Extra " + i, ref: "test/extra-" + i, group: "Test" })));
const levels = ["low", "medium", "high"].map((value) => ({ value }));
const fresh = () => ({
  agents: [{ id: "omp", name: "omp", icon: "omp", path: "/test/config.yml", wired: true,
    fields: [
      { key: "model", label: "model", value: models[0].value, options: models },
      { key: "effort", label: "thinking", value: "high", options: levels },
      ...["slow", "vision"].flatMap((role) => [
        { key: role, label: role, value: models[0].value, options: models },
        { key: role + "_thinking", label: role + " thinking", value: "low", options: levels },
      ]),
    ] }],
  profiles: [], settings: {},
});
const words = {
  en: { slow: "slow", vision: "vision", thinking: "slow thinking", medium: "medium", high: "high" },
  zh: { slow: "慢模型", vision: "视觉", thinking: "慢模型思考", medium: "中", high: "高" },
};

async function setup(t, engine, lang) {
  const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
  const page = await browser.newPage({ viewport: { width: 1135, height: 816 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(5000);
  const errors = [], writes = [], waiting = new Map();
  const data = { state: fresh() };
  data.state.settings = { lang, theme: "light" };
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname !== "magpie.test") throw new Error("Unexpected network request: " + url);
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs={lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return route.fulfill({ json: data.state });
    if (url.pathname === "/api/set") {
      const body = req.postDataJSON();
      let release;
      const held = new Promise((r) => { release = r; });
      const write = { body, release };
      writes.push(write);
      waiting.get(writes.length - 1)?.(write);
      await held;
      data.state = structuredClone(data.state);
      const fields = data.state.agents.find((a) => a.id === body.agent).fields;
      fields.find((f) => f.key === body.field).value = body.value;
      return route.fulfill({ json: data.state });
    }
    if (url.pathname === "/api/usage/quotas") return route.fulfill({ json: [] });
    if (url.pathname === "/api/groups") return route.fulfill({ json: { groups: [] } });
    if (url.pathname === "/api/agents/cli") return route.fulfill({ json: { agents: {}, pending: false } });
    if (url.pathname === "/api/providers") return route.fulfill({ json: { providers: [], gateway: { running: true } } });
    if (url.pathname === "/api/plugins") return route.fulfill({ json: { plugins: [] } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    return route.fulfill({ body: await fs.readFile(file), contentType });
  });
  t.after(async () => {
    // Release held requests even when an assertion fails, then close the
    // isolated browser. The application itself is never started.
    writes.forEach((w) => w.release());
    if (process.env.ARTIFACT_DIR) {
      await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, t.name.replace(/[^a-z0-9-]/gi, "_") + ".png") });
    }
    await browser.close();
    assert.deepEqual(errors, []);
  });
  await page.goto("http://magpie.test/");
  await page.locator('.row.agent[data-id="omp"] .ag-link').click();
  const anchor = page.locator('.row.agent[data-id="omp"] .field.extra[data-key="tiers"]');
  const item = (name) => page.locator("#pop:not([hidden]) #list li:not(.group)").filter({ has: page.locator(".v", { hasText: new RegExp("^" + name + "$") }) });
  const open = async (name) => { await anchor.click(); if (name) await item(name).click(); };
  const write = (i) => writes[i] ? Promise.resolve(writes[i]) : new Promise((r) => waiting.set(i, r));
  const redrawn = async (action) => {
    const old = await anchor.elementHandle();
    await page.evaluate(() => {
      window.pickerHidden = 0;
      window.pickerObserver?.disconnect();
      window.pickerObserver = new MutationObserver((rs) => {
        window.pickerHidden += rs.filter((r) => r.attributeName === "hidden" && (r.oldValue !== null || r.target.hidden)).length;
      });
      window.pickerObserver.observe(document.querySelector("#pop"), { attributes: true, attributeOldValue: true, attributeFilter: ["hidden"] });
    });
    await action();
    await page.waitForFunction((e) => !e.isConnected, old);
    await old.dispose();
  };
  const refresh = () => redrawn(() => page.evaluate(() => window.dispatchEvent(new Event("focus"))));
  const beside = async (kept = true) => {
    const a = await anchor.boundingBox(), p = await page.locator("#pop:not([hidden])").boundingBox();
    assert.ok(a && p, "the picker and its current entry stay visible");
    assert.ok(Math.abs(a.x - p.x) < 2 && Math.abs(a.y + a.height + 5 - p.y) < 2, JSON.stringify({ anchor: a, pop: p }));
    if (kept) assert.equal(await page.evaluate(() => window.pickerHidden || 0), 0, "redraw closed/reopened the picker");
  };
  const effort = async (value) => page.locator("#effortRange").evaluate((r, value) => {
    r.value = value;
    r.dispatchEvent(new Event("input", { bubbles: true }));
    r.dispatchEvent(new Event("change", { bubbles: true }));
  }, String(value));
  return { page, data, writes, write, anchor, item, open, redrawn, refresh, beside, effort, w: words[lang] };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) for (const lang of ["en", "zh"]) {
  for (const target of ["model", "thinking"]) test(`${engine} ${lang}: model reply keeps the roles menu and its next ${target} picker anchored`, { timeout: 20000 }, async (t) => {
    const s = await setup(t, engine, lang);
    for (const [i, model] of ["Beta", "Gamma"].entries()) {
      await s.open(s.w.slow);
      await s.item(model).click();
      const pending = await s.write(i);
      await s.open();
      await s.redrawn(() => pending.release());
      // The menu's notes must use the reply's fields, not its old snapshot.
      assert.ok((await s.item(s.w.slow).innerText()).includes(model));
      await s.beside();
      await s.item(target === "model" ? s.w.vision : s.w.thinking).click();
      await s.beside(false); // moving into a submenu is an explicit open
      await s.page.keyboard.press("Escape");
    }
    assert.deepEqual(s.writes.map((w) => w.body), ["beta", "gamma"].map((m) => ({ agent: "omp", field: "slow", value: "magpie/test/" + m })));
  });

  test(`${engine} ${lang}: a rebound picker still follows resize and closes offscreen`, { timeout: 20000 }, async (t) => {
    const s = await setup(t, engine, lang);
    await s.open(s.w.slow);
    await s.refresh();
    await s.beside();
    await s.page.setViewportSize({width: 950, height: 816});
    await s.page.waitForFunction(() => {
      const anchor = document.querySelector('.row.agent[data-id="omp"] .field.extra[data-key="tiers"]');
      const pop = document.querySelector('#pop');
      const a = anchor.getBoundingClientRect(), p = pop.getBoundingClientRect();
      return !pop.hidden && Math.abs(p.x - Math.max(8, Math.min(a.x, innerWidth - p.width - 8))) < 2 && Math.abs(p.y - a.bottom - 5) < 2;
    });
    await s.page.setViewportSize({width: 950, height: 100});
    await s.page.waitForFunction(() => document.querySelector('#pop').hidden);
  });

  test(`${engine} ${lang}: a model picker keeps its search, provider, cursor and scroll through a fresh state`, { timeout: 20000 }, async (t) => {
    const s = await setup(t, engine, lang);
    await s.open(s.w.slow);
    await s.page.locator('#pickerRail [data-group="Test"]').click();
    await s.page.locator("#q").fill("a");
    await s.page.keyboard.press("ArrowDown");
    const selected = await s.page.locator("#list li.sel .v").textContent();
    await s.page.locator("#list").evaluate((e) => { e.scrollTop = 80; });
    const scroll = await s.page.locator("#list").evaluate((e) => e.scrollTop);
    assert.ok(scroll > 0);
    s.data.state = structuredClone(s.data.state);
    s.data.state.agents[0].fields.find((f) => f.key === "slow").value = models[1].value;
    await s.refresh();
    await s.beside();
    assert.equal(await s.page.locator("#q").inputValue(), "a");
    assert.equal(await s.page.locator("#q").evaluate((e) => e === document.activeElement), true);
    assert.equal(await s.page.locator('#pickerRail [data-group="Test"]').evaluate((e) => e.classList.contains("on")), true);
    assert.equal(await s.page.locator("#list li.sel .v").textContent(), selected);
    assert.equal(await s.page.locator("#list").evaluate((e) => e.scrollTop), scroll);
    assert.equal(await s.page.locator("#list li.cur .v").textContent(), "Beta");
    // Picking the formerly selected model is a write, not a stale no-op.
    await s.item("Alpha").click();
    const pending = await s.write(0);
    assert.equal(pending.body.value, models[0].value);
    pending.release();
  });

  test(`${engine} ${lang}: thinking follows refreshed fields and keeps queued choices through redraw`, { timeout: 20000 }, async (t) => {
    const s = await setup(t, engine, lang);
    await s.open(s.w.thinking);
    s.data.state = structuredClone(s.data.state);
    s.data.state.agents[0].fields.find((f) => f.key === "slow_thinking").value = "medium";
    await s.refresh();
    await s.beside();
    assert.equal(await s.page.locator("#effortValue").textContent(), s.w.medium);
    await s.effort(3); // Default, low, medium, high
    const first = await s.write(0);
    await s.refresh(); // state still says medium while high is being saved
    await s.beside();
    assert.equal(await s.page.locator("#effortValue").textContent(), s.w.high, "an in-flight choice was reset by the read");
    assert.ok((await s.anchor.getAttribute("aria-label")).includes(s.w.high), "the refreshed entry lost the pending level");
    await s.effort(1);
    await s.effort(2);
    assert.equal(s.writes.length, 1, "redraw lost the slider's write queue");
    first.release();
    const second = await s.write(1);
    assert.equal(second.body.value, "low");
    second.release();
    const third = await s.write(2);
    assert.equal(third.body.value, "medium");
    third.release();
    await s.page.waitForFunction((value) => document.querySelector("#status").textContent.includes("→ " + value), s.w.medium);
    await s.refresh();
    await s.beside();
    assert.equal(await s.page.locator("#effortValue").textContent(), s.w.medium);
    assert.deepEqual(s.writes.map((w) => w.body.field), ["slow_thinking", "slow_thinking", "slow_thinking"]);
  });

  test(`${engine} ${lang}: a save reply between press and release keeps the role click`, { timeout: 20000 }, async (t) => {
    const s = await setup(t, engine, lang);
    await s.open(s.w.slow);
    await s.item("Beta").click();
    const pending = await s.write(0);
    await s.open();
    const rect = await s.item(s.w.thinking).boundingBox();
    await s.page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await s.page.mouse.down();
    await s.redrawn(() => pending.release());
    await s.page.mouse.up();
    await s.page.locator("#effortControl:not([hidden])").waitFor();
    assert.equal(await s.page.locator("#effortTitle").textContent(), s.w.thinking);
    await s.beside(false);
  });

  test(`${engine} ${lang}: a model reply during a thinking drag keeps the thumb and saves its choice`, { timeout: 20000 }, async (t) => {
    const s = await setup(t, engine, lang);
    await s.open(s.w.slow);
    await s.item("Beta").click();
    const pending = await s.write(0);
    await s.open(s.w.thinking);
    const range = s.page.locator("#effortRange"), rect = await range.boundingBox();
    await s.page.mouse.move(rect.x + rect.width / 3, rect.y + rect.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(rect.x + rect.width - 2, rect.y + rect.height / 2);
    assert.equal(await range.inputValue(), "3");
    await s.redrawn(() => pending.release());
    assert.equal(await range.inputValue(), "3", "redraw reset the active drag");
    await s.beside();
    await s.page.mouse.up();
    const thinking = await s.write(1);
    assert.deepEqual(thinking.body, { agent: "omp", field: "slow_thinking", value: "high" });
    thinking.release();
    await s.page.waitForFunction((value) => document.querySelector("#status").textContent.includes("→ " + value), s.w.high);
    await s.refresh();
    await s.beside();
    assert.equal(await s.page.locator("#effortValue").textContent(), s.w.high);
  });

  for (const gone of ["agent", "entry", "hidden", "field", "levels"]) test(`${engine} ${lang}: closes only when the picker ${gone} is unavailable after redraw`, { timeout: 20000 }, async (t) => {
    const s = await setup(t, engine, lang);
    await s.open(["field", "levels"].includes(gone) ? s.w.thinking : s.w.slow);
    s.data.state = structuredClone(s.data.state);
    if (gone === "agent") s.data.state.agents = [];
    if (gone === "entry") s.data.state.agents[0].fields = s.data.state.agents[0].fields.filter((f) => ["model", "effort"].includes(f.key));
    if (gone === "hidden") s.data.state.settings.agentsHidden = ["omp"];
    if (gone === "field") s.data.state.agents[0].fields = s.data.state.agents[0].fields.filter((f) => f.key !== "slow_thinking");
    if (gone === "levels") Object.assign(s.data.state.agents[0].fields.find((f) => f.key === "slow_thinking"), { value: "", options: [] });
    await s.refresh();
    assert.equal(await s.page.locator("#pop").isHidden(), true);
    assert.equal(s.writes.length, 0);
  });
}
