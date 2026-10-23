const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
function harness(onTick, remote = false) {
  const elements = {},
    listeners = {},
    saved = [],
    state = { cancelled: false };
  let tick = 0;
  const captures = [];
  class BrowserPDFCapture {
    constructor() {
      captures.push(this);
    }
    close() {}
    retry() {}
    abortPending() {}
  }
  const element = () => ({
    setAttribute() {},
    append(...children) {
      for (const child of children) elements[child.id] = child;
    },
    addEventListener(name, fn) {
      this[name] = fn;
    },
  });
  const page = {
    querySelector() {
      return null;
    },
  };
  const browser = {
    currentURI: { spec: "https://example.org/article" },
    contentDocument: remote ? null : page,
    browsingContext: {
      currentWindowGlobal: {
        getActor: () => ({ sendQuery: async () => "<html></html>" }),
      },
    },
  };
  const doc = {
    readyState: "complete",
    querySelector: () => browser,
    createElementNS: () => element(),
    getElementById: (id) => elements[id],
    documentElement: {
      insertBefore(bar) {
        elements[bar.id] = bar;
      },
    },
  };
  const win = {
    document: doc,
    loadURI() {},
    setTimeout,
    clearTimeout,
    closed: false,
    addEventListener: (name, fn) => (listeners[name] = fn),
    removeEventListener: (name) => delete listeners[name],
    close() {
      this.closed = true;
      listeners.unload?.();
    },
  };
  let candidate;
  const exports = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync(
        require.resolve("../src/modules/InteractiveBrowser.ts"),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    {
      exports,
      URL,
      Services: { io: { newURI: (url) => url } },
      require: (id) =>
        id.includes("BrowserPDFCapture")
          ? { BrowserPDFCapture }
          : id.includes("utils/utils")
            ? {
                Utils: {
                  attachPDFBytes: async (bytes, item, state) => {
                    if (!state.cancelled) saved.push([bytes, item]);
                  },
                },
              }
            : id.includes("locale")
              ? { getString: (key) => key }
              : {
                  browserUserAgent: () => undefined,
                  findPDFURL: () => candidate,
                },
      Zotero: {
        openInViewer: () => win,
        debug() {},
        Promise: {
          delay: async () => {
            await onTick?.({
              tick: ++tick,
              win,
              state,
              elements,
              setCaptureWait: () => {
                const c = captures[0];
                c.pending = new Promise(
                  (resolve, reject) =>
                    (c.close = () => reject(new Error("cancelled"))),
                );
              },
              setCapture: (bytes) =>
                (captures[0].pending = Promise.resolve({
                  bytes,
                  url: "https://example.org/paper.pdf",
                })),
              setPDF: () =>
                (candidate = new URL("https://example.org/paper.pdf")),
            });
          },
        },
      },
      ztoolkit: {
        getGlobal: () =>
          class {
            parseFromString() {
              return page;
            }
          },
      },
    },
  );
  return {
    state,
    win,
    fetch: () =>
      exports.InteractiveBrowser.fetch(
        new URL("https://example.org/article"),
        { getField: () => "10.1234/test", getDisplayTitle: () => "Fixture" },
        state,
        async (...args) => saved.push(args),
      ),
    saved,
    api: exports.InteractiveBrowser,
  };
}
test("manual window waits for confirmation, saves once and closes without cancellation", async () => {
  const h = harness(({ setPDF }) => setPDF());
  await h.fetch();
  assert.equal(h.saved.length, 1);
  assert.equal(h.state.cancelled, false);
  assert.equal(h.win.closed, true);
});
test("remote page actor can supply HTML for PDF detection", async () => {
  const h = harness(({ setPDF }) => setPDF(), true);
  await h.fetch();
  assert.equal(h.saved.length, 1);
});
test("closing verification window cancels and never saves", async () => {
  const h = harness(({ win }) => win.close());
  await h.fetch();
  assert.equal(h.state.cancelled, true);
  assert.equal(h.saved.length, 0);
});
test("plugin shutdown closes verification window and cancels pending work", async () => {
  const h = harness(() => h.api.closeAll());
  await h.fetch();
  assert.equal(h.win.closed, true);
  assert.equal(h.state.cancelled, true);
  assert.equal(h.saved.length, 0);
});

test("a PDF response after verification attaches bytes directly without fetching its URL again", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.4\nfixture");
  const h = harness(({ setCapture }) => setCapture(bytes));
  await h.fetch();
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.saved[0][0], bytes);
  assert.equal(h.saved[0][1].getField(), "10.1234/test");
  assert.equal(h.win.closed, true);
  assert.equal(h.state.cancelled, false);
});

test("skipping a PDF stream does not report a saved attachment or cancel the next mirror", async () => {
  let started = false;
  const h = harness(({ setCaptureWait, elements }) => {
    if (started) return;
    started = true;
    setCaptureWait();
    setTimeout(() => elements["scipdf-verification-skip"].click(), 0);
  });
  await assert.rejects(h.fetch(), /mirror skipped/);
  assert.equal(h.saved.length, 0);
  assert.equal(h.state.cancelled, false);
  assert.equal(h.win.closed, true);
});
