const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
function harness(cancelOnWrite = false, platformPath = "/temporary/pdf") {
  const exports = {},
    imports = [],
    writes = [],
    removed = [],
    state = { cancelled: false };
  let temps = 0;
  runInNewContext(
    ts.transpileModule(
      readFileSync(require.resolve("../src/utils/utils.ts"), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    {
      exports,
      require: () => ({}),
      Uint8Array,
      Zotero: {
        Attachments: {
          createTemporaryStorageDirectory: async () => {
            temps++;
            return {
              path: platformPath,
              clone() {
                return {
                  path: platformPath,
                  append(name) {
                    this.path +=
                      (platformPath.includes("\\") ? "\\" : "/") + name;
                  },
                };
              },
            };
          },
          importFromFile: async (options) => imports.push(options),
        },
        logError() {},
      },
      ztoolkit: {
        getGlobal: () => ({
          write: async (...args) => {
            writes.push(args);
            if (cancelOnWrite) state.cancelled = true;
          },
          remove: async (path) => removed.push(path),
        }),
      },
    },
  );
  return {
    Utils: exports.Utils,
    imports,
    writes,
    removed,
    state,
    get temps() {
      return temps;
    },
    item: { id: 42, libraryID: 7, getField: () => "Article" },
  };
}
test("received PDF bytes become a stored child attachment in the originating item library", async () => {
  const h = harness(),
    bytes = new TextEncoder().encode("%PDF-1.4\nfixture");
  await h.Utils.attachPDFBytes(bytes, h.item, h.state);
  assert.equal(h.imports.length, 1);
  assert.equal(h.imports[0].parentItemID, 42);
  assert.equal(h.imports[0].libraryID, 7);
  assert.equal(h.imports[0].contentType, "application/pdf");
  assert.equal(h.imports[0].file, "/temporary/pdf/article.pdf");
  assert.equal(h.writes[0][1], bytes);
  assert.deepEqual(h.removed, ["/temporary/pdf"]);
});
test("an HTML verification page never becomes a PDF child attachment", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      h.Utils.attachPDFBytes(
        new TextEncoder().encode("<html>verify</html>"),
        h.item,
        h.state,
      ),
    /non-PDF/,
  );
  assert.equal(h.imports.length, 0);
  assert.equal(h.temps, 0);
});
test("cancelling after the temporary write cleans up without importing", async () => {
  const h = harness(true);
  await h.Utils.attachPDFBytes(
    new TextEncoder().encode("%PDF-1.4\nfixture"),
    h.item,
    h.state,
  );
  assert.equal(h.imports.length, 0);
  assert.deepEqual(h.removed, ["/temporary/pdf"]);
});

test("Windows storage path with Chinese characters uses native separators for both write and attachment import", async () => {
  const directory = String.raw`D:\zotero文献\storage\tmp-EHxBVT`;
  const h = harness(false, directory);
  await h.Utils.attachPDFBytes(
    new TextEncoder().encode("%PDF-1.4\nfixture"),
    h.item,
    h.state,
  );
  const expected = directory + String.raw`\article.pdf`;
  assert.equal(h.writes[0][0], expected);
  assert.equal(h.imports[0].file, expected);
  assert.equal(h.imports[0].parentItemID, 42);
  assert.ok(!h.writes[0][0].includes("/"));
  assert.deepEqual(h.removed, [directory]);
});
