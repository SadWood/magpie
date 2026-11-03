// Gateway-only plugins have options and private-data-free diagnostics. APIs are fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = process.env.MAGPIE_GATEWAY_ASSETS || path.resolve(__dirname, "../assets");

function server(lang, pluginState) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true }, plugins: [] });
    if (url.pathname === "/api/groups") return json({ groups: [], pools: [] });
    if (url.pathname === "/api/gateway/trace") return json({ routes: [] });
    if (url.pathname === "/api/plugins/market" || url.pathname === "/api/plugins" || url.pathname === "/api/plugins/listings") return json(url.pathname === "/api/plugins" ? pluginState : url.pathname === "/api/plugins/listings" ? { listings: [] } : { listings: [], state: pluginState });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

const SPEC = "/fixtures/context-plugin";
for (const engine of ["chromium", "webkit"]) {
  test(engine + ": gateway configuration and diagnostics", async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({channel:"chromium"}));
    t.after(() => browser.close());
    for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
      await t.test(lang, async () => {
        const page = await browser.newPage({viewport:{width:980,height:820}});
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(60000);
        const posted = [], errors = [];
        let conflict = false;
        const state = {bun:true, bunVersion:"1.4.3", plugins:[{
          spec:SPEC, providers:[], moved:[], isGateway:true, gatewayOnly:true,
          optionsExample:{serverUrl:"http://127.0.0.1:8000",gatewayTimeoutMs:5000},
          gateway:{calls:3,failures:1,avgMillis:5.5,lastOutcome:"ready",lastBytes:120},
        }]};
        page.on("pageerror", e=>errors.push(e.message));
        await page.route("**/*",server(lang,state));
        await page.route("**/api/plugins/options-snapshot", r=>r.fulfill({json:{options:state.plugins[0].options || {},optionsJSON:JSON.stringify(state.plugins[0].options || {}),version:"v1"}}));
        await page.route("**/api/plugins/options-cas", r=>{
          const data=r.request().postDataJSON(); posted.push(data);
          if (conflict) return r.fulfill({json:{conflict:true}});
          state.plugins[0].options=JSON.parse(data.optionsJSON);
          return r.fulfill({json:{options:state.plugins[0].options,version:"v2"}});
        });
        await page.goto("http://magpie.test/?view=plugins");
        const installed = {en:"Installed",zh:"已安装","zh-TW":"已安裝",ja:"インストール済み",de:"Installiert"}[lang];
        await page.locator(":is(.lib-tabs .opt, .nav-s):visible",{hasText:installed}).click();
        const row=page.locator("#view-plugins .pm-row");
        assert.equal(await row.locator(".pm-chip.kind.pv").count(),0);
        const hook={en:"Request hook",zh:"请求 Hook","zh-TW":"請求 Hook",ja:"リクエストフック",de:"Anfrage-Hook"}[lang];
        assert.equal((await row.locator(".pm-chip.kind.mw").innerText()).trim(),hook);
        const line=row.locator(".pm-gateway");
        await line.waitFor();
        assert.match(await line.innerText(), /120/);
        if(lang!=="en") assert.doesNotMatch(await line.innerText(),/Context injected|calls,|bytes injected/);
        const options={en:"Options",zh:"选项","zh-TW":"選項",ja:"オプション",de:"Optionen"}[lang];
        await row.getByRole("button",{name:options,exact:true}).click();
        const textarea=row.locator(".pm-opts textarea");
        assert.deepEqual(JSON.parse(await textarea.inputValue()),state.plugins[0].optionsExample);
        await textarea.fill('{"serverUrl":"http://127.0.0.1:9000","gatewayTimeoutMs":6000}');
        const save={en:"Save",zh:"保存","zh-TW":"儲存",ja:"保存",de:"Speichern"}[lang];
        await row.locator(".pm-opts").getByRole("button",{name:save,exact:true}).click();
        await textarea.waitFor({state:"detached"});
        assert.deepEqual(posted,[{spec:SPEC,optionsJSON:'{"serverUrl":"http://127.0.0.1:9000","gatewayTimeoutMs":6000}',version:"v1"}]);
        await row.getByRole("button",{name:options,exact:true}).click();
        const draft = row.locator(".pm-opts textarea");
        await draft.fill('{"draft":"keep"}');
        conflict = true;
        await row.locator(".pm-opts").getByRole("button",{name:save,exact:true}).click();
        await row.locator(".pm-opts-err").filter({hasText: /draft|草稿|下書き|Entwurf/i}).waitFor();
        assert.equal(await row.locator(".pm-opts textarea").inputValue(), '{"draft":"keep"}');
        assert.equal(state.plugins[0].options.serverUrl, "http://127.0.0.1:9000");
        assert.deepEqual(errors,[]);
        await page.close();
      });
    }
  });
  test(engine + ": JSON editor sends large unknown numbers as source text", async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({channel:"chromium"}));
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:980,height:820}});
    const raw = '{"future":9007199254740993,"nested":{"n":9007199254740995}}';
    const state = {bun:true, plugins:[{spec:SPEC,providers:[],moved:[],isGateway:true,gatewayOnly:true,options:JSON.parse(raw)}]};
    let sent;
    await page.route("**/*",server("en",state));
    await page.route("**/api/plugins/options-snapshot", r=>r.fulfill({json:{options:state.plugins[0].options,optionsJSON:raw,version:"v1"}}));
    await page.route("**/api/plugins/options-cas", r=>{ sent=r.request().postDataJSON(); return r.fulfill({json:{options:state.plugins[0].options,version:"v2"}}); });
    await page.goto("http://magpie.test/?view=plugins");
    await page.locator(":is(.lib-tabs .opt, .nav-s):visible",{hasText:"Installed"}).click();
    const row = page.locator("#view-plugins .pm-row");
    await row.getByRole("button",{name:"Options",exact:true}).click();
    const textarea = row.locator(".pm-opts textarea");
    assert.equal(await textarea.inputValue(),raw);
    await row.locator(".pm-opts").getByRole("button",{name:"Save",exact:true}).click();
    await textarea.waitFor({state:"detached"});
    assert.equal(sent.optionsJSON,raw);
    await page.close();
  });
  test(engine + ": cancelled save response does not replace a reopened draft", async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({channel:"chromium"}));
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:980,height:820}});
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const state = {bun:true, plugins:[{spec:SPEC,providers:[],moved:[],isGateway:true,gatewayOnly:true,options:{value:1}}]};
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route("**/*",server("en",state));
    await page.route("**/api/plugins/options-snapshot", r => r.fulfill({json:{options:{value:1},optionsJSON:'{"value":1}',version:"v1"}}));
    await page.route("**/api/plugins/options-cas", async r => { await pending; await r.fulfill({json:{conflict:true}}); });
    await page.goto("http://magpie.test/?view=plugins");
    await page.locator(":is(.lib-tabs .opt, .nav-s):visible",{hasText:"Installed"}).click();
    const row = page.locator("#view-plugins .pm-row");
    await row.getByRole("button",{name:"Options",exact:true}).click();
    const sent = page.waitForRequest("**/api/plugins/options-cas");
    await row.locator(".pm-opts").getByRole("button",{name:"Save",exact:true}).click();
    await sent;
    await row.locator(".pm-opts").getByRole("button",{name:"Cancel",exact:true}).click();
    const response = page.waitForResponse("**/api/plugins/options-cas");
    release();
    await response;
    // Wait until the old operation clears busy and allows a new editor.
    await row.getByRole("button",{name:"Options",exact:true}).click();
    await row.locator(".pm-opts textarea").fill('{"newDraft":true}');
    assert.equal(await row.locator(".pm-opts textarea").inputValue(), '{"newDraft":true}');
    assert.deepEqual(errors, []);
  });

}
