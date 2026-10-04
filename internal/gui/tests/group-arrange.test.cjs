// Run with Node's test runner and Playwright on the module path; see README.md.
// #779: the Routing page's groups are put in the user's own order, as the
// Agents page's rows are (#57): a group's logos are its handle, with a grip
// in the row's margin drawn only while the row is under the pointer (always
// there it is clutter, the owner: 一直出现太丑了); dragging it moves the row,
// right-clicking the row (or clicking the handle) opens Move up and Move
// down, and Alt+↑/↓ moves it from the keyboard, which stays on it. Each move
// posts groups/arrange with every group by id, the removed ones last, and
// the list is drawn as the answer has it. No click moves the page. In
// English and Chinese, Chromium and WebKit.
// 图标列固定容纳最大堆叠，名称和说明保持纵向对齐；覆盖全部文字大小、
// 深浅色、桌面和窄屏。几何测量在一次 evaluate 内查询当前 DOM，避免
// 异步保存重绘时读到已脱离文档的旧行。
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const models = [
  { id: "a/m", name: "m", providerName: "A", icon: "codex-color" },
  { id: "b/m", name: "m", providerName: "B", icon: "factory" },
  { id: "c/m", name: "m", providerName: "C", icon: "claudecode-color" },
  { id: "d/m", name: "m", providerName: "D", icon: "cursor" },
  { id: "e/m", name: "m", providerName: "E", icon: "antigravity-color" },
  { id: "a/x", name: "x", providerName: "A", icon: "codex-color" },
];
const info = (ids) => ids.map((id) => ({ id, ready: true, provider: id.split("/")[0], icon: models.find((m) => m.id === id).icon }));
const all = {
  one: { id: "one", name: "One", members: ["a/x"], ready: true, memberInfo: info(["a/x"]) },
  two: { id: "two", name: "Two", members: ["a/m", "b/m"], ready: true, memberInfo: info(["a/m", "b/m"]) },
  three: { id: "three", name: "Three", members: ["a/m", "b/m", "c/m"], ready: true, memberInfo: info(["a/m", "b/m", "c/m"]) },
  four: { id: "four", name: "Four", members: ["a/m", "b/m", "c/m", "d/m"], ready: true, memberInfo: info(["a/m", "b/m", "c/m", "d/m"]) },
  "auto-m": { id: "auto-m", name: "Model M", members: ["a/m", "b/m", "c/m", "d/m", "e/m"], auto: true, ready: true, memberInfo: info(["a/m", "b/m", "c/m", "d/m", "e/m"]) },
  "auto-z": { id: "auto-z", name: "auto-z", members: [], auto: true, hidden: true, memberInfo: [] },
};

const words = {
  en: { saved: "Group order saved", up: "Move up", down: "Move down" },
  zh: { saved: "路由组顺序已保存", up: "上移", down: "下移" },
};

function serve(lang, posts, { web = true, theme = "light", layout = false, textSize = 100 } = {}) {
  let order = layout ? ["one", "two", "three", "four", "auto-m", "auto-z"] : ["one", "two", "auto-m", "auto-z"];
  const groups = () => ({ models, pools: [], deciders: [], found: true, groups: order.map((id) => all[id]) });
  const state = { agents: [{ id: "claude", name: "Claude Code", path: "/test/claude", fields: [] }], profiles: [], settings: { lang, theme, textSize } };
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = ${JSON.stringify({ lang, theme, web, textSize })};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/gateway/trace") {
      if (url.searchParams.get("wait")) return new Promise(() => {}); // nothing more comes
      return json({ mine: true, now: new Date().toISOString(), seq: 1, totals: { requests: 0, rerouted: 0, errors: 0 }, routes: [] });
    }
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/groups") return json(groups());
    if (url.pathname === "/api/groups/arrange") {
      const body = JSON.parse(r.request().postData() || "{}");
      posts.push(body.order);
      order = body.order;
      return json(groups());
    }
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await r.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const listed = (page) => page.locator(".rt-groups > .rt-group").evaluateAll((rs) => rs.map((r) => r.dataset.id));
// each row's margin grip: what it draws, how much shows, and where
const grips = (page) => page.evaluate(() => [...document.querySelectorAll(".rt-groups > .rt-group")].map((r) => {
  const h = r.querySelector(".rt-ghandle"), s = getComputedStyle(h, "::before"), hb = h.getBoundingClientRect(), rb = r.getBoundingClientRect();
  const left = hb.left + parseFloat(s.left), w = parseFloat(s.width);
  return { id: r.dataset.id, image: s.backgroundImage, opacity: s.opacity, inRow: left >= rb.left && left + w <= hb.left + 0.5, x: left + w / 2, y: hb.top + hb.height / 2 };
}));
const opacities = (page) => page.evaluate(() => [...document.querySelectorAll(".rt-groups > .rt-group .rt-ghandle")].map((h) => getComputedStyle(h, "::before").opacity));
// 图标不侵入文字；单图标到最大堆叠都保留相同列宽，各行文字对齐。
async function checkLogos(page) {
  const rows = await page.evaluate(() => [...document.querySelectorAll(".rt-groups > .rt-group")].map((r) => {
    const h = r.querySelector(".rt-ghandle"), hb = h.getBoundingClientRect(), rb = r.getBoundingClientRect();
    const main = r.querySelector(".main").getBoundingClientRect();
    const discs = h.querySelectorAll(".disc"), icons = [...(discs.length ? discs : h.querySelectorAll(".ic"))];
    return { id: r.dataset.id, rowLeft: rb.left, handleLeft: hb.left, handleRight: hb.right, handleWidth: hb.width, mainLeft: main.left,
      icons: icons.map((e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; }) };
  }));
  for (const r of rows) {
    for (const i of r.icons) assert(i.right + 4 <= r.mainLeft,
      `${r.id}: logo overlaps the title: ${JSON.stringify(r)}`);
  }
  for (const r of rows) {
    assert(r.icons.length, `${r.id}: no logos rendered`);
    assert(Math.abs(r.handleWidth - rows[0].handleWidth) <= 0.5, `${r.id}: logo columns have different widths`);
    assert(Math.abs(r.mainLeft - rows[0].mainLeft) <= 0.5, `${r.id}: titles and descriptions do not align`);
    for (const i of r.icons) {
      assert(i.width > 0, `${r.id}: empty logo`);
      assert(i.left >= r.handleLeft - 0.5 && i.right <= r.handleRight + 0.5,
        `${r.id}: logo outside its handle: ${JSON.stringify(r)}`);
      assert(i.left >= r.rowLeft + 1, `${r.id}: logo clipped at the card's edge`);
    }
  }
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    const w = words[lang];
    test(`${engine} ${lang}: routing groups put in order by hand`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" })).newPage();
      t.after(async () => {
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-group-arrange.png`) });
        }
        await browser.close();
      });
      page.setDefaultTimeout(5000);
      const errors = [], posts = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang, posts));
      await page.goto("http://magpie.test/?view=routing");
      await page.locator(".rt-groups > .rt-group").nth(2).waitFor();
      assert.deepEqual(await listed(page), ["one", "two", "auto-m"]);
      await page.locator(".rt-gsec").evaluate((x) => x.scrollIntoView({ block: "center" })); // as the reader would
      await page.waitForTimeout(200);
      assert.equal(await page.locator(".rt-group[data-id=two] .disc").count(), 2);
      assert.equal(await page.locator(".rt-group[data-id=auto-m] .disc.more").textContent(), "+2");
      await checkLogos(page);
      const at = () => page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => e.scrollTop).map((e) => [e.id || e.className, e.scrollTop]).join(";"));
      const before = await at();
      const saved = () => page.waitForFunction((m) => document.querySelector("#status").textContent.includes(m), w.saved);

      // the grip: drawn by every row, shown by none with the pointer away,
      // by the row under it alone, in the row's margin, not over its logos
      await page.mouse.move(1, 1);
      let g = await grips(page);
      for (const x of g) {
        assert.match(x.image, /gradient/, `${x.id}'s grip draws nothing`);
        assert.equal(x.opacity, "0", `${x.id}'s grip is drawn with the pointer away`);
        assert(x.inRow, `${x.id}'s grip is off its row or over its logos: ${JSON.stringify(x)}`);
      }
      await page.locator(".rt-groups > .rt-group").nth(1).locator(".main").hover();
      await page.waitForFunction(() => {
        const os = [...document.querySelectorAll(".rt-groups > .rt-group .rt-ghandle")].map((h) => getComputedStyle(h, "::before").opacity);
        return os[1] === "1" && os.every((o, i) => i === 1 || o === "0");
      });
      await page.mouse.move(1, 1);
      await page.waitForFunction(() => [...document.querySelectorAll(".rt-groups > .rt-group .rt-ghandle")].every((h) => getComputedStyle(h, "::before").opacity === "0"));
      assert.deepEqual(await opacities(page), ["0", "0", "0"]);

      // right-click: Move up is off on the first, Move down moves it, and
      // the order sent has every group, the removed one last
      await page.locator(".rt-group[data-id=one] .main").click({ button: "right" });
      const menu = page.locator(".row-menu");
      await menu.waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: w.up }).isDisabled(), true, "Move up on the first group");
      await menu.getByRole("menuitem", { name: w.down }).click();
      await saved();
      assert.deepEqual(posts.at(-1), ["two", "one", "auto-m", "auto-z"]);
      assert.deepEqual(await listed(page), ["two", "one", "auto-m"]);
      assert.equal(await page.locator(".rt-gedit").count(), 0, "the right-click opened the editor");

      // Alt+↓ on a focused row's handle moves it, and the keyboard stays on it
      await page.locator(".rt-group[data-id=one] .rt-ghandle").focus();
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForFunction(() => [...document.querySelectorAll(".rt-groups > .rt-group")].map((r) => r.dataset.id).join() === "two,auto-m,one");
      assert.deepEqual(posts.at(-1), ["two", "auto-m", "one", "auto-z"]);
      await page.waitForFunction(() => document.activeElement?.closest(".rt-group")?.dataset.id === "one");
      await page.keyboard.press("Alt+ArrowUp");
      await page.waitForFunction(() => [...document.querySelectorAll(".rt-groups > .rt-group")].map((r) => r.dataset.id).join() === "two,one,auto-m");
      assert.deepEqual(posts.at(-1), ["two", "one", "auto-m", "auto-z"]);

      // a click on the handle opens the same menu, not the editor
      await page.mouse.move(1, 1);
      await page.locator(".rt-group[data-id=auto-m] .rt-ghandle").click();
      await menu.waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: w.down }).isDisabled(), true, "Move down on the last group");
      assert.equal(await page.locator(".rt-gedit").count(), 0, "the handle opened the editor");
      await menu.getByRole("menuitem", { name: w.up }).click();
      await page.waitForFunction(() => [...document.querySelectorAll(".rt-groups > .rt-group")].map((r) => r.dataset.id).join() === "two,auto-m,one");
      assert.deepEqual(posts.at(-1), ["two", "auto-m", "one", "auto-z"]);

      // dragging by the grip moves the row to the top
      await page.mouse.move(1, 1);
      g = await grips(page);
      for (const x of g) assert(Number.isFinite(x.x) && Number.isFinite(x.y), `grip has no rendered position: ${JSON.stringify(g)}`);
      const n = posts.length;
      await page.mouse.move(g[2].x, g[2].y);
      await page.mouse.down();
      await page.mouse.move(g[2].x, g[0].y - 10, { steps: 12 });
      await page.locator(".rt-groups > .rt-group.dragging").waitFor();
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector(".rt-groups > .rt-group")?.dataset.id === "one");
      assert.equal(posts.length, n + 1);
      assert.deepEqual(posts.at(-1), ["one", "two", "auto-m", "auto-z"]);
      assert.equal(await page.locator(".rt-gedit").count(), 0, "letting go opened the editor");
      assert.equal(await page.locator(".row-menu").count(), 0, "letting go opened the menu");
      await checkLogos(page);

      assert.equal(await at(), before, "a click moved the page");
      const missing = await page.evaluate(() => [
        "Group order saved", "Move up", "Move down", "Arrange {agent}",
        "Drag to reorder — agents' model lists show the groups in this order · Alt+↑/↓ to move",
      ].filter((k) => !I18N.zh[k]));
      assert.deepEqual(missing, [], "every string has its Chinese");
      assert.deepEqual(errors, []);
    });

    for (const theme of ["light", "dark"]) {
      test(`${engine} ${lang} ${theme}: routing logos fit their handles and leave room for titles`, async (t) => {
        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
        t.after(() => browser.close());
        for (const [web, zoom] of [[false, 1], [false, 1.1], [false, 1.25], [false, 1.5], [true, 1]]) {
          // Wails 缩放会减少窗口内的 CSS 像素，按实际缩放后的视口验证。
          const viewport = (width) => ({ width: Math.round(width / zoom), height: Math.round(1400 / zoom) });
          const page = await browser.newPage({ viewport: viewport(1100), deviceScaleFactor: zoom, reducedMotion: "reduce" });
          page.setDefaultTimeout(5000);
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));
          page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
          await page.route("**/*", serve(lang, [], { web, theme, layout: true, textSize: zoom * 100 }));
          await page.goto("http://magpie.test/?view=routing");
          await page.locator(".rt-groups > .rt-group").nth(4).waitFor();
          assert.equal(await page.title(), "magpie");
          assert.equal(new URL(page.url()).searchParams.get("view"), "routing");
          assert.equal(await page.locator("body.web").count(), web ? 1 : 0);
          assert.equal(await page.locator(".rt-group[data-id=three] .disc").count(), 3);
          assert.equal(await page.locator(".rt-group[data-id=four] .disc.more").textContent(), "+1");
          assert.equal(await page.locator(".rt-group[data-id=auto-m] .disc.more").textContent(), "+2");
          for (const width of web ? [1100, 560, 390] : [1100, 560]) {
            await page.setViewportSize(viewport(width));
            await page.locator(".rt-gsec").evaluate((x) => x.scrollIntoView({ block: "center" }));
            if (process.env.ARTIFACT_DIR) {
              await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
              await page.locator(".rt-groups").screenshot({ path: path.join(process.env.ARTIFACT_DIR,
                `${engine}-${lang}-${theme}-${web ? "web" : "window"}-${width}-${zoom}-logos.png`) });
            }
            await checkLogos(page);
          }
          assert.deepEqual(errors, []);
          await page.close();
        }
      });
    }
  }
}
