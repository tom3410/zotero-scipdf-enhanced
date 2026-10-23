/* eslint-disable mocha/no-setup-in-describe -- diagnose wraps test callbacks to preserve native error messages */
import { assert } from "chai";
import { config } from "../package.json";

function diagnose(fn: () => Promise<void>) {
  return async function () {
    try {
      await fn();
    } catch (error) {
      const message = `Verification test: ${String(error)}\n${(error as any)?.message}\n${(error as any)?.stack}`;
      const wrapped = new Error(message);
      Object.defineProperty(wrapped, "message", {
        value: message,
        enumerable: true,
      });
      throw wrapped;
    }
  };
}
async function waitUntil(check: () => any) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await Zotero.Promise.delay(50);
  }
  const windows: string[] = [];
  for (const win of Services.wm.getEnumerator("zotero:basicViewer")) {
    const browser = (win as any).document.querySelector("browser");
    windows.push(
      "uri=" +
        browser?.currentURI?.spec +
        " js=" +
        browser?.browsingContext?.allowJavascript +
        " sandbox=" +
        browser?.browsingContext?.sandboxFlags +
        " doc=" +
        browser?.contentDocument?.documentURI +
        " html=" +
        browser?.contentDocument?.body?.innerHTML?.slice(0, 300) +
        " " +
        (win as any).document.documentURI +
        " toolbar=" +
        !!(win as any).document.getElementById("scipdf-verification-toolbar"),
    );
  }
  throw new Error(
    "Verification UI did not appear: " +
      JSON.stringify(windows) +
      "; " +
      JSON.stringify(Zotero.getErrors(true).slice(-5)),
  );
}
function configure(url: string) {
  Zotero.Prefs.set(
    config.prefsPrefix + "resolvers",
    JSON.stringify([
      {
        name: "Sci-Hub",
        method: "GET",
        url: url + "{doi}",
        mode: "html",
        selector: "#pdf",
        attribute: "src",
        automatic: false,
      },
    ]),
    true,
  );
  Zotero.Prefs.set(config.prefsPrefix + ".interactiveDownload", true, true);
}
function viewer() {
  for (const win of Services.wm.getEnumerator("zotero:basicViewer")) {
    if ((win as any).document.getElementById("scipdf-verification-toolbar"))
      return win as any;
  }
}
async function makeItem(doi: string) {
  const item = new Zotero.Item("journalArticle");
  item.libraryID = Zotero.Libraries.userLibraryID;
  item.setField("title", "Synthetic verification fixture");
  item.setField("DOI", doi);
  await item.saveTx();
  return item;
}

describe("manual verification browser", function () {
  this.timeout(30000);

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
    "native viewer loads the local verification page",
    diagnose(async () => {
      const win = (Zotero.openInViewer as any)(
        "http://127.0.0.1:18769/verify",
        { allowJavaScript: true },
      );
      try {
        await waitUntil(() =>
          win.document
            .querySelector("browser")
            ?.currentURI?.spec?.includes("/verify"),
        );
      } finally {
        win.close();
      }
    }),
  );

  it(
    "executes redirects, waits for a manual click, shares cookies and saves a PDF",
    diagnose(async () => {
      configure("http://127.0.0.1:18769/start/");
      const item = await makeItem("10.1234/fixture");
      let win: any;
      try {
        const pending = (Zotero as any).scipdf.api.fetchPDF([item]);
        win = await waitUntil(viewer);
        const browser = win.document.querySelector("browser");
        const checkbox = await waitUntil(() =>
          browser.contentDocument?.getElementById("human-checkbox"),
        );
        assert.lengthOf(item.getAttachments(), 0);
        // Only a local fixture click. Never solve a live CAPTCHA in the test.
        checkbox.click();
        browser.contentDocument.getElementById("confirm").click();
        await pending;
        assert.isTrue(win.closed);
        assert.lengthOf(item.getAttachments(), 1);
        const attachment = Zotero.Items.get(item.getAttachments()[0]);
        assert.include(
          String(
            await Zotero.File.getContentsAsync(
              String(await attachment.getFilePathAsync()),
            ),
          ),
          "%PDF-",
        );
        const xhr = await Zotero.HTTP.request(
          "GET",
          "http://127.0.0.1:18769/requests",
        );
        const requests = JSON.parse(xhr.responseText || "[]");
        assert.isTrue(
          requests.some(
            (r: any) =>
              r.url === "/files/paper.pdf" &&
              r.cookie.includes("scipdf_fixture=verified") &&
              r.referrer.endsWith("/result/article"),
          ),
        );
      } finally {
        if (win && !win.closed) win.close();
        await item.eraseTx();
      }
    }),
  );

  it(
    "closing the window cancels the remaining batch",
    diagnose(async () => {
      configure("http://127.0.0.1:18769/cancel/");
      const first = await makeItem("10.1234/cancel1"),
        second = await makeItem("10.1234/cancel2");
      try {
        const pending = (Zotero as any).scipdf.api.fetchPDF([first, second]);
        const win = await waitUntil(viewer);
        win.close();
        await pending;
        assert.lengthOf(first.getAttachments(), 0);
        assert.lengthOf(second.getAttachments(), 0);
        const xhr = await Zotero.HTTP.request(
          "GET",
          "http://127.0.0.1:18769/requests",
        );
        assert.notInclude(xhr.responseText || "", "/cancel/10.1234/cancel2");
      } finally {
        await first.eraseTx();
        await second.eraseTx();
      }
    }),
  );
});
