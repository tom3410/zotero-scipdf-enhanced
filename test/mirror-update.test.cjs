const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

function load(file, imports = {}, globals = {}) {
  const exports = {};
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  runInNewContext(outputText, {
    exports,
    URL,
    Date,
    require(id) {
      assert.ok(Object.hasOwn(imports, id), id);
      return imports[id];
    },
    ...globals,
  });
  return exports;
}
const list = load("src/modules/mirrorURLs.ts");
const resolver = load("src/modules/CustomResolver.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
function page(links = [], text = "") {
  return {
    body: { textContent: text },
    querySelectorAll: () =>
      links.map(([href, textContent]) => ({
        getAttribute: () => href,
        textContent,
      })),
  };
}

test("legacy separators, templates, trailing slashes and duplicates normalize", () => {
  const value =
    "https://SCI-HUB.example; https://sci-hub.example/\nhttps://sci-hub.example/{doi}，https://mirror.example/；";
  assert.deepEqual(plain(list.parseMirrorList(value)), {
    urls: ["https://sci-hub.example/{doi}", "https://mirror.example/{doi}"],
    invalid: [],
  });
  assert.equal(list.parseMirrorList(" \n;,；").urls.length, 0);
});

test("rejects invalid URLs, credentials and unsafe schemes without silently dropping them", () => {
  const parsed = list.parseMirrorList(
    "https://good.example javascript:alert(1) https://user:pass@host.example https://bad.example/?redirect=x",
  );
  assert.equal(parsed.urls.length, 1);
  assert.equal(parsed.invalid.length, 3);
  assert.equal(
    list.normalizeMirrorURL("https://source.example/?page=mirrors"),
    "https://source.example/?page=mirrors",
  );
});

test("extracts homepage links and plain URLs, excludes articles and unrelated links", () => {
  const doc = page(
    [
      ["//sci-hub.example/", "Open"],
      ["https://alt.example/", "Sci-Hub 最新地址"],
      ["https://news.example/article", "Sci-Hub 新闻"],
      ["https://ads.example/", "Advertisement"],
      ["javascript:alert(1)", "Sci-Hub"],
      ["https://sci-hub.example/10.1/article", "Paper"],
      ["https://source.example/", "Sci-Hub 导航"],
    ],
    "地址 https://scihub.example/，https://sci-hub.example/；https://unrelated.example/",
  );
  assert.deepEqual(
    plain(list.extractMirrorURLs(doc, "https://source.example/list")),
    [
      "https://sci-hub.example/",
      "https://alt.example/",
      "https://scihub.example/",
    ],
  );
});

function updater({ prefs = {}, saved = [], response, request } = {}) {
  const appended = [];
  const options = [];
  const state = { alive: true };
  const manager = {
    get customResolvers() {
      return saved;
    },
    appendCustomResolversInZotero(values) {
      appended.push(...values);
      saved.push(...values);
    },
  };
  const api = load(
    "src/modules/MirrorUpdater.ts",
    {
      "../utils/prefs": {
        getPref: (k) => prefs[k],
        setPref: (k, v) => (prefs[k] = v),
      },
      "./CustomResolver": resolver,
      "./CustomResolverManager": { CustomResolverManager: { shared: manager } },
      "./mirrorURLs": list,
    },
    {
      addon: { data: state },
      Zotero: {
        debug() {},
        HTTP: {
          async request(method, url, opts) {
            options.push({ method, url, ...opts });
            if (request) return request();
            return (
              response || {
                status: 200,
                responseText: "fixture",
                responseURL: "https://source.example/",
              }
            );
          },
        },
      },
      ztoolkit: {
        getGlobal: () =>
          class {
            parseFromString() {
              return page([], "https://sci-hub.example/");
            }
          },
      },
    },
  );
  return { api, options, appended, state, manager };
}

test("automatic fetch is opt-in and throttled across restarts", async () => {
  const prefs = { mirrorSourceURL: "https://source.example/" };
  const u = updater({ prefs });
  await u.api.refreshMirrorsIfDue();
  assert.equal(u.options.length, 0);
  prefs.mirrorAutoUpdate = true;
  await u.api.refreshMirrorsIfDue();
  await u.api.refreshMirrorsIfDue();
  assert.equal(u.options.length, 1);
  assert.equal(u.appended.length, 1);
  assert.ok(Number(prefs.mirrorLastSuccess));
  assert.equal(u.options[0].timeout, 15000);
  assert.equal(u.options[0].errorDelayMax, 0);
});

test("background update retains manual entries and disabled download flags without duplicates", async () => {
  const existing = resolver.sciHubCustomResolver(
    "https://sci-hub.example/",
    false,
  );
  const prefs = {
    mirrorSourceURL: "https://source.example/",
    mirrorAutoUpdate: true,
    automaticDownload: false,
  };
  const saved = [
    existing,
    resolver.sciHubCustomResolver("https://manual.example/", false),
  ];
  const u = updater({ prefs, saved });
  await u.api.refreshMirrorsIfDue();
  assert.equal(u.appended.length, 0);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].automatic, false);
});

test("HTTP failure does not mutate saved entries or mark a successful update", async () => {
  const prefs = {
    mirrorSourceURL: "https://source.example/",
    mirrorAutoUpdate: true,
  };
  const u = updater({ prefs, response: { status: 503 } });
  await u.api.refreshMirrorsIfDue();
  assert.equal(u.appended.length, 0);
  assert.equal(prefs.mirrorLastSuccess, undefined);
  await u.api.refreshMirrorsIfDue();
  assert.equal(u.options.length, 1);
});

test("in-flight automatic update is discarded if its source changes", async () => {
  let resolve;
  const prefs = {
    mirrorSourceURL: "https://source.example/",
    mirrorAutoUpdate: true,
  };
  const u = updater({
    prefs,
    request: () => new Promise((done) => (resolve = done)),
  });
  const pending = u.api.refreshMirrorsIfDue();
  prefs.mirrorSourceURL = "https://other.example/";
  resolve({ status: 200, responseText: "fixture" });
  await pending;
  assert.equal(u.appended.length, 0);
});

function preferences({
  value = "https://manual.example/",
  fetch = async () => ["https://sci-hub.example/"],
} = {}) {
  const elements = {};
  for (const name of [
    "scihubUrl",
    "autoDownload",
    "interactiveDownload",
    "mirrorSource",
    "mirrorAutoUpdate",
    "fetchMirrors",
    "status",
    "lastUpdate",
    "saveMirrors",
  ]) {
    elements[name] = {
      dataset: {},
      attributes: {},
      listeners: {},
      value: "",
      checked: false,
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
      addEventListener(k, fn) {
        this.listeners[k] = fn;
      },
    };
  }
  const prefs = { mirrorSourceURL: "https://source.example/" };
  let saved = [resolver.sciHubCustomResolver(value, false)];
  let removals = 0;
  const win = {
    document: {
      addEventListener() {},
      querySelector(selector) {
        return elements[selector.replace("#zotero-prefpane-scipdf-", "")];
      },
    },
  };
  const api = load(
    "src/modules/preferenceScript.ts",
    {
      "../../package.json": { config: { addonRef: "scipdf" } },
      "../utils/prefs": {
        getPref: (k) => prefs[k],
        setPref: (k, v) => (prefs[k] = v),
      },
      "./CustomResolver": resolver,
      "./CustomResolverManager": {
        CustomResolverManager: {
          shared: {
            get customResolvers() {
              return saved;
            },
            removeAllCustomResolversInZotero() {
              saved = [];
              removals++;
            },
            appendCustomResolversInZotero(values) {
              saved.push(...values);
            },
          },
        },
      },
      "./MirrorUpdater": { fetchMirrorURLs: fetch },
      "./mirrorURLs": list,
    },
    { addon: { data: { alive: true } } },
  );
  return {
    api,
    win,
    elements,
    prefs,
    get saved() {
      return saved;
    },
    get removals() {
      return removals;
    },
  };
}

test("invalid editor draft is preserved, saved configuration stays intact", async () => {
  const p = preferences();
  await p.api.registerPrefsScripts(p.win);
  p.elements.scihubUrl.value = "bad-url\nhttps://valid.example/";
  p.elements.saveMirrors.listeners.click();
  assert.equal(p.removals, 0);
  assert.equal(p.saved.length, 1);
  assert.equal(
    p.elements.status.attributes["data-l10n-id"],
    "scipdf-pref-invalid-urls",
  );
});

test("fetch merges into editor, preserves manual URLs and disabled downloads", async () => {
  const p = preferences();
  await p.api.registerPrefsScripts(p.win);
  await p.elements.fetchMirrors.listeners.click();
  assert.equal(p.saved.length, 2);
  assert.ok(p.elements.scihubUrl.value.includes("\n"));
  assert.equal(
    p.saved.every((r) => r.automatic === false),
    true,
  );
  assert.equal(p.elements.fetchMirrors.disabled, false);
  await p.elements.fetchMirrors.listeners.click();
  assert.equal(p.saved.length, 2);
});

test("fetch failure leaves the editor and stored resolvers unchanged", async () => {
  const p = preferences({
    fetch: async () => {
      throw new Error("timeout");
    },
  });
  await p.api.registerPrefsScripts(p.win);
  const before = p.elements.scihubUrl.value;
  await p.elements.fetchMirrors.listeners.click();
  assert.equal(p.elements.scihubUrl.value, before);
  assert.equal(p.removals, 0);
  assert.equal(p.elements.fetchMirrors.disabled, false);
  assert.equal(
    p.elements.status.attributes["data-l10n-id"],
    "scipdf-pref-fetch-failed",
  );
});
