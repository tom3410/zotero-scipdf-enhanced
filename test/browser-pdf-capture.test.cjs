const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
function harness() {
  const observers = new Map();
  const exports = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync(
        require.resolve("../src/modules/BrowserPDFCapture.ts"),
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
      Uint8Array,
      Promise,
      Services: {
        obs: {
          addObserver: (o, t) => observers.set(t, o),
          removeObserver: (o, t) => {
            assert.equal(observers.get(t), o);
            observers.delete(t);
          },
        },
      },
      Components: {
        interfaces: {
          nsIHttpChannel: 1,
          nsITraceableChannel: 2,
          nsIBinaryInputStream: 3,
        },
        results: { NS_BINDING_ABORTED: 99 },
        isSuccessCode: (s) => s === 0,
        classes: {
          "@mozilla.org/binaryinputstream;1": {
            createInstance: () => ({
              setInputStream(stream) {
                this.stream = stream;
              },
              readByteArray: function (count) {
                return this.stream.splice(0, count);
              },
            }),
          },
        },
      },
      ChromeUtils: { generateQI: () => () => {} },
      Zotero: { debug() {} },
    },
  );
  const capture = new exports.BrowserPDFCapture({
    browsingContext: { id: 10, children: [{ id: 11, children: [] }] },
  });
  function response({
    id = 10,
    status = 200,
    type = "application/pdf",
    disposition = 'attachment; filename="paper.pdf"',
    url = "https://example.org/paper.pdf",
  } = {}) {
    const c = {
      loadInfo: { browsingContextID: id },
      responseStatus: status,
      contentType: type,
      URI: { spec: url },
      getResponseHeader: () => disposition,
      QueryInterface() {
        return this;
      },
      cancelled: false,
      cancel() {
        this.cancelled = true;
        this.listener?.onStopRequest(this, 99);
      },
      setNewListener(listener) {
        this.listener = listener;
        return { onStopRequest: () => (this.originalStopped = true) };
      },
    };
    observers.get("http-on-examine-response")?.observe(c);
    return c;
  }
  function finish(c, text = "%PDF-1.4\nfixture", status = 0) {
    const bytes = Array.from(new TextEncoder().encode(text));
    c.listener.onStartRequest(c);
    c.listener.onDataAvailable(c, bytes, 0, bytes.length);
    c.listener.onStopRequest(c, status);
  }
  return { capture, response, finish, observers };
}
test("PDF attachment response is consumed before native Save As receives it", async () => {
  const h = harness(),
    c = h.response();
  assert.equal(c.originalStopped, true);
  h.finish(c);
  const result = await h.capture.pending;
  assert.equal(new TextDecoder().decode(result.bytes), "%PDF-1.4\nfixture");
  h.capture.close();
  assert.equal(h.observers.size, 0);
});
test("nested verification frame responses are captured; unrelated windows and privileged requests are untouched", () => {
  const h = harness();
  for (const id of [0, 20]) {
    const c = h.response({ id });
    assert.equal(c.listener, undefined);
    assert.equal(c.cancelled, false);
  }
  assert.ok(h.response({ id: 11 }).listener);
  h.capture.close();
});
test("HTML verification responses, errors, and non-PDF downloads are not captured", () => {
  const h = harness();
  for (const options of [
    { type: "text/html" },
    { status: 403 },
    {
      type: "application/octet-stream",
      url: "https://example.org/file.zip",
      disposition: 'attachment; filename="file.zip"',
    },
  ])
    assert.equal(h.response(options).listener, undefined);
  h.capture.close();
});
test("generic binary downloads with PDF filenames are captured", async () => {
  const h = harness(),
    c = h.response({ type: "application/octet-stream" });
  h.finish(c);
  assert.ok(await h.capture.pending);
  h.capture.close();
});
test("duplicate PDF navigations cannot open a second save dialog", async () => {
  const h = harness(),
    c = h.response(),
    second = h.response();
  assert.equal(second.cancelled, true);
  h.finish(c);
  const received = h.capture.pending;
  await received;
  assert.equal(h.capture.retry(), undefined);
  assert.equal(h.capture.pending, received);
  h.capture.close();
});
test("interrupted response can be retried, and closing removes observers and cancels active streams", async () => {
  const h = harness(),
    c = h.response();
  h.finish(c, "partial", 99);
  await assert.rejects(h.capture.pending, /interrupted/);
  assert.equal(h.capture.retry(), "https://example.org/paper.pdf");
  assert.equal(h.capture.pending, undefined);
  const next = h.response();
  const waiting = h.capture.pending;
  h.capture.close();
  assert.equal(next.cancelled, true);
  await assert.rejects(waiting, /cancelled|interrupted/);
  assert.equal(h.observers.size, 0);
  h.capture.close();
});
