const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { URL } = require("node:url");
const ts = require("typescript");
function load(path, imports = {}, globals = {}) {
  const exports = {};
  runInNewContext(
    ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    { exports, require: (id) => imports[id], URL, ...globals },
  );
  return exports;
}
const pdfPage = load("../src/modules/pdfPage.ts", {}, { Zotero: {} });
const identifiers = load("../src/utils/identifierPatterns.ts");
const { Utils } = load("../src/utils/utils.ts", {
  "./identifierPatterns": identifiers,
});
const item = (doi = "10.1038/s41567-025-02822-y") => ({
  isRegularItem: () => true,
  getDisplayTitle: () => "Test article",
  getField: (field) => (field === "DOI" ? doi : "10.1016/j.scib.2023.01.001"),
  getBestAttachments: async () => [],
});
test("issue 85: full DOI, URL and DOI label never produce truncated candidates", () => {
  const doi = "10.1038/s41567-025-02822-y";
  for (const text of [
    doi,
    `http://dx.doi.org/${doi}`,
    `https://doi.org/${doi}`,
    `DOI: ${doi}`,
  ]) {
    assert.deepEqual(Array.from(identifiers.matchDOIs(text)), [doi]);
  }
});
test("explicit DOI wins over other identifiers and case variants deduplicate", async () => {
  assert.deepEqual(Array.from(await Utils.extractDOIs(item())), [
    "10.1038/s41567-025-02822-y",
  ]);
  assert.equal(
    identifiers.matchDOIs("10.48550/ARXIV.2205.11462 10.48550/arxiv.2205.11462")
      .length,
    1,
  );
});
test("missing DOI still falls back to URL and preserves complete letter suffixes", async () => {
  const doi = "10.1038/s41567-025-02822-y";
  const entry = item("");
  entry.getField = (field) => (field === "url" ? `https://doi.org/${doi}` : "");
  assert.deepEqual(Array.from(await Utils.extractDOIs(entry)), [doi]);
});
function harness(request, interactive, save) {
  const windows = [],
    calls = [],
    imports = [];
  const ui = {
    ...Utils,
    extractDOIs: Utils.extractDOIs,
    attachRemotePDF: async (url) => {
      await save?.(url);
      imports.push(url.href);
    },
    showPopWin: (title, text, type, closeTime) => {
      const w = {
        title,
        closeTime,
        closed: false,
        updates: [],
        addDescription() {},
        changeLine(line) {
          this.updates.push(line);
        },
      };
      w.win = {
        close() {
          w.closed = true;
        },
      };
      windows.push(w);
      return w;
    },
  };
  const { SciHubFetcher } = load(
    "../src/modules/SciHubFetcher.ts",
    {
      "../utils/locale": {
        getString: (key, options) =>
          options ? JSON.stringify(options.args) : key,
      },
      "../utils/utils": { Utils: ui },
      "../utils/prefs": { getPref: () => !!interactive },
      "./pdfPage": pdfPage,
      "./InteractiveBrowser": {
        InteractiveBrowser: {
          fetch: async (...args) => {
            if (!interactive) throw new Error("Unexpected popup");
            return interactive(...args);
          },
        },
      },
      "./CustomResolverManager": {
        CustomResolverManager: {
          shared: {
            customResolvers: [
              { url: "https://a.example/{doi}" },
              { url: "https://b.example/{doi}" },
            ],
          },
        },
      },
    },
    {
      Zotero: {
        debug() {},
        HTTP: {
          request: async (method, url, options) => {
            calls.push({ url, options });
            return request({ url, options, windows, calls });
          },
        },
      },
      ztoolkit: { log() {} },
    },
  );
  return {
    run: (items) => SciHubFetcher.updateItems(items, false),
    windows,
    calls,
    imports,
  };
}
const page = (status, found = false) => ({
  status,
  statusText: String(status),
  responseXML: {
    querySelector: (selector) =>
      selector === "#pdf"
        ? found
          ? { getAttribute: () => "https://pdf.example/test.pdf" }
          : null
        : selector === "body"
          ? { innerHTML: "Please try to search again using DOI" }
          : null,
  },
});
test("502 advances to the next mirror with bounded requests and persistent progress", async () => {
  const h = harness(({ calls, options }) => {
    assert.equal(options.timeout, 15000);
    assert.equal(options.errorDelayMax, 0);
    assert.equal(options.successCodes, false);
    return calls.length === 1 ? page(502) : page(200, true);
  });
  await h.run([item()]);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every((c) => c.url.endsWith("02822-y")));
  assert.equal(h.windows[0].closeTime, 0);
  assert.equal(h.windows[0].updates.length, 2);
  assert.equal(h.windows[0].closed, true);
  assert.equal(h.windows.at(-1).title, "popwin-fetchsuccess");
  assert.equal(h.imports.length, 1);
});
test("click cancellation aborts the request and stops remaining mirrors and items", async () => {
  let aborted = false;
  const h = harness(
    ({ options, windows }) =>
      new Promise((resolve, reject) => {
        options.cancellerReceiver(() => {
          aborted = true;
          reject(new Error("cancelled"));
        });
        windows[0].win.close();
      }),
  );
  await h.run([item(), item()]);
  assert.equal(aborted, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.imports.length, 0);
  assert.equal(h.windows.at(-1).title, "popwin-cancelled");
});
test("throttled hosts are not revisited for later items", async () => {
  const h = harness(() => page(429));
  await h.run([item(), item()]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.windows.at(-1).title, "popwin-fetchfailed");
});
test("timeout does not block remaining mirrors and is not reported as PDF absent", async () => {
  const h = harness(({ calls }) => {
    if (calls.length === 1) throw new Error("timeout");
    return page(200);
  });
  await h.run([item()]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.windows.at(-1).title, "popwin-fetchfailed");
});
test("normal progress cleanup does not cancel the next item", async () => {
  const h = harness(() => page(200, true));
  await h.run([item(), item()]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.imports.length, 2);
  assert.equal(
    h.windows.filter((w) => w.title === "popwin-fetchsuccess").length,
    2,
  );
});
test("cancellation after response completion prevents attachment import", async () => {
  const h = harness(({ windows }) => {
    windows[0].win.close();
    return page(200, true);
  });
  await h.run([item(), item()]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.imports.length, 0);
  assert.equal(h.windows.at(-1).title, "popwin-cancelled");
});
test("all mirrors explicitly missing the PDF produce the not-found result", async () => {
  const h = harness(() => page(200));
  await h.run([item()]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.windows.at(-1).title, "popwin-pdfnotavaliable");
});

test("PDF links resolve against the final redirected page URL", async () => {
  const h = harness(() => ({
    status: 200,
    responseURL: "https://new.example/articles/result",
    responseXML: {
      querySelector(selector) {
        return selector === "#pdf"
          ? { getAttribute: () => "../files/paper.pdf" }
          : null;
      },
    },
  }));
  await h.run([item()]);
  assert.deepEqual(h.imports, ["https://new.example/files/paper.pdf"]);
});
test("403 opens a manual verification flow and then saves the result", async () => {
  let opened = 0;
  const h = harness(
    () => page(403),
    async (url, entry, state, save) => {
      opened++;
      await save(
        new URL("https://verified.example/paper.pdf"),
        "https://verified.example/article",
      );
    },
  );
  await h.run([item()]);
  assert.equal(opened, 1);
  assert.equal(h.imports.length, 1);
  assert.equal(h.windows.at(-1).title, "popwin-fetchsuccess");
});
test("unrecognized HTML opens the browser instead of reporting PDF absent", async () => {
  let opened = 0;
  const h = harness(
    () => ({ status: 200, responseXML: { querySelector: () => null } }),
    async (url, entry, state) => {
      opened++;
      state.cancelled = true;
    },
  );
  await h.run([item(), item()]);
  assert.equal(opened, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.windows.at(-1).title, "popwin-cancelled");
});
test("a skipped browser is offered only once per article, not for every mirror", async () => {
  let opened = 0;
  const h = harness(
    () => page(403),
    async () => {
      opened++;
      throw new Error("skip");
    },
  );
  await h.run([item(), item()]);
  assert.equal(opened, 2);
  assert.equal(h.calls.length, 4);
});
test("HTML verification responses are never imported as PDF attachments", async () => {
  const bytes = Uint8Array.from(
    Buffer.from("<html>Complete verification</html>"),
  );
  let imports = 0;
  const module = load(
    "../src/utils/utils.ts",
    { "./identifierPatterns": identifiers },
    {
      Zotero: {
        HTTP: {
          request: async (method, url, options) => {
            assert.equal(
              options.headers.Referer,
              "https://final.example/article",
            );
            assert.equal(options.headers["User-Agent"], "same-browser-UA");
            return { status: 200, response: bytes.buffer };
          },
        },
        Attachments: {
          importFromFile: async () => {
            imports++;
          },
        },
      },
    },
  );
  await assert.rejects(
    () =>
      module.Utils.attachRemotePDF(
        new URL("https://file.example/paper.pdf"),
        item(),
        {
          pageURL: "https://final.example/article",
          userAgent: "same-browser-UA",
          state: { cancelled: false },
        },
      ),
    /non-PDF/,
  );
  assert.equal(imports, 0);
});

test("first successful PDF stops all remaining mirror requests for that article", async () => {
  const h = harness(() => page(200, true));
  await h.run([item()]);
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url).host, "a.example");
  assert.equal(h.imports.length, 1);
});
test("success stops current article mirrors and continues with the next article", async () => {
  const h = harness(() => page(200, true));
  await h.run([item("10.1234/first"), item("10.1234/second")]);
  assert.deepEqual(
    h.calls.map((c) => c.url),
    ["https://a.example/10.1234/first", "https://a.example/10.1234/second"],
  );
  assert.equal(h.imports.length, 2);
});
test("a detected link whose attachment import fails still tries the next mirror", async () => {
  let attempts = 0;
  const h = harness(
    () => page(200, true),
    undefined,
    async () => {
      if (++attempts === 1) throw new Error("Attachment download failed");
    },
  );
  await h.run([item()]);
  assert.equal(h.calls.length, 2);
  assert.equal(new URL(h.calls[1].url).host, "b.example");
  assert.equal(h.imports.length, 1);
  assert.equal(h.windows.at(-1).title, "popwin-fetchsuccess");
});
