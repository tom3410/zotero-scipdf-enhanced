/* eslint-disable mocha/no-setup-in-describe -- error wrappers preserve details in the native reporter */
import { assert } from "chai";
import { BrowserPDFCapture } from "../../src/modules/BrowserPDFCapture";
import { Utils } from "../../src/utils/utils";

function report(fn: () => Promise<void>) {
  return async function () {
    try {
      await fn();
    } catch (error) {
      const message = `${String(error)}\n${(error as any)?.stack}`;
      const wrapped = new Error(message);
      Object.defineProperty(wrapped, "message", {
        value: message,
        enumerable: true,
      });
      throw wrapped;
    }
  };
}

describe("native PDF response capture and item import", function () {
  this.timeout(20000);

  before(async function () {
    try {
      await Zotero.HTTP.request("GET", "http://127.0.0.1:18769/requests", {
        timeout: 1000,
      });
    } catch {
      this.skip();
    }
  });

  it(
    "captures an attachment response stream and imports it as the originating item's PDF",
    report(async () => {
      const target = new Zotero.Item("journalArticle");
      target.libraryID = Zotero.Libraries.userLibraryID;
      target.setField("title", "Native response capture fixture");
      await target.saveTx();
      const capture = new BrowserPDFCapture({
        browsingContext: { id: -1, children: [] },
      });
      const url = "http://127.0.0.1:18769/download/fixture.pdf";
      // Exercise the real HTTP stream in headless Zotero. Only this synthetic URL
      // is scoped in; production's browser-context matching has separate tests.
      (capture as any).belongsToBrowser = (channel: nsIHttpChannel) =>
        channel.URI.spec === url;
      const oldToolkit = (globalThis as any).ztoolkit;
      (globalThis as any).ztoolkit = (Zotero as any).scipdf.data.ztoolkit;
      try {
        const originalRequest = Zotero.HTTP.request("GET", url, {
          responseType: "arraybuffer",
          timeout: 5000,
        }).catch(() => undefined);
        const until = Date.now() + 5000;
        while (!capture.pending && Date.now() < until)
          await Zotero.Promise.delay(25);
        assert.exists(
          capture.pending,
          "real HTTP observer did not receive PDF",
        );
        const result = await capture.pending!;
        assert.equal(result.url, url);
        assert.equal(
          String.fromCharCode(...result.bytes.subarray(0, 5)),
          "%PDF-",
        );
        await Utils.attachPDFBytes(result.bytes, target, { cancelled: false });
        await originalRequest;
        assert.lengthOf(target.getAttachments(), 1);
        const attachment = Zotero.Items.get(target.getAttachments()[0]);
        assert.equal(attachment.parentID, target.id);
        assert.equal(attachment.libraryID, target.libraryID);
        assert.isTrue(attachment.isPDFAttachment());
        const file = await attachment.getFilePathAsync();
        assert.isString(file);
        assert.include(
          String(await Zotero.File.getContentsAsync(String(file))),
          "%PDF-",
        );
      } finally {
        capture.close();
        (globalThis as any).ztoolkit = oldToolkit;
        await target.eraseTx();
      }
    }),
  );

  it(
    "does not capture an unrelated privileged HTTP PDF request",
    report(async () => {
      const capture = new BrowserPDFCapture({
        browsingContext: { id: -1, children: [] },
      });
      try {
        const xhr = await Zotero.HTTP.request(
          "GET",
          "http://127.0.0.1:18769/download/fixture.pdf",
          { responseType: "arraybuffer", timeout: 5000 },
        );
        assert.equal(xhr.status, 200);
        assert.isUndefined(capture.pending);
      } finally {
        capture.close();
      }
    }),
  );
});
