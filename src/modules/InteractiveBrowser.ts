import { BrowserPDFCapture } from "./BrowserPDFCapture";
import { Utils } from "../utils/utils";
import { getString } from "../utils/locale";
import { browserUserAgent, findPDFURL } from "./pdfPage";

export interface DownloadState {
  cancelled: boolean;
  cancelRequest?: () => void;
  interactiveAttempted?: boolean;
  onInteractive?: () => void;
}

export class InteractiveBrowser {
  private static windows = new Set<Window>();
  static closeAll() {
    for (const win of this.windows) if (!win.closed) win.close();
    this.windows.clear();
  }

  static async fetch(
    url: URL,
    item: Zotero.Item,
    state: DownloadState,
    save: (pdf: URL, pageURL: string) => Promise<void>,
  ): Promise<void> {
    if (state.cancelled) return;
    state.onInteractive?.();
    // Use Zotero's normal viewer and cookie jar, never an external browser's cookies.
    const open = Zotero.openInViewer as unknown as (
      url: string,
      options: { allowJavaScript: boolean; customUserAgent?: string },
    ) => Window;
    const viewerOptions = {
      allowJavaScript: true,
      customUserAgent: browserUserAgent(),
    };
    // Start blank so the PDF response observer is installed before navigation.
    const win = open(
      `about:blank#scipdf-${Date.now()}-${Math.random()}`,
      viewerOptions,
    );
    this.windows.add(win);
    let completed = false,
      skipped = false,
      lastAttempt = "",
      captureRetry = 0;
    let capture: BrowserPDFCapture | undefined;
    const cancel = () => {
      state.cancelled = true;
      capture?.close();
      if (!win.closed) win.close();
    };
    const onClose = () => {
      if (!completed && !skipped) {
        state.cancelled = true;
        capture?.close();
        const abort = state.cancelRequest;
        state.cancelRequest = undefined;
        abort?.();
      }
    };
    state.cancelRequest = cancel;
    const deadline = Date.now() + 300000;
    try {
      // openInViewer can initially expose a complete about:blank document.
      // Wait for the real chrome browser widget, not only readyState.
      while (
        !win.closed &&
        (win.document.readyState !== "complete" ||
          !win.document.querySelector("browser"))
      ) {
        if (state.cancelled || Date.now() > deadline)
          throw new Error("Verification window cancelled or timed out");
        await Zotero.Promise.delay(100);
      }
      if (state.cancelled || win.closed) return;
      // Ignore the initial about:blank unload while the chrome window is being created.
      win.addEventListener("unload", onClose, { once: true });
      const doc = win.document;
      const create = (name: string) =>
        doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          name,
        ) as HTMLElement;
      const toolbar = create("div");
      toolbar.id = "scipdf-verification-toolbar";
      toolbar.setAttribute(
        "style",
        "padding:12px;background:Canvas;color:CanvasText;border-bottom:1px solid GrayText;font:14px sans-serif;",
      );
      const instructions = create("div");
      instructions.textContent = getString("interactive-help");
      const article = create("div");
      article.setAttribute("style", "margin:6px 0;user-select:text;");
      article.textContent = `${String(item.getField("DOI") || "")} — ${item.getDisplayTitle()}`;
      const status = create("div");
      status.id = "scipdf-verification-status";
      status.setAttribute("role", "status");
      status.setAttribute("style", "margin:6px 0;overflow-wrap:anywhere;");
      status.textContent = getString("interactive-waiting");
      const retry = create("button");
      retry.id = "scipdf-verification-retry";
      retry.textContent = getString("interactive-retry");
      retry.addEventListener("click", () => {
        lastAttempt = "";
        captureRetry++;
        const retryURL = capture?.retry();
        if (retryURL)
          (win as any).loadURI(Services.io.newURI(retryURL), viewerOptions);
        status.textContent = getString("interactive-waiting");
      });
      const skip = create("button");
      skip.id = "scipdf-verification-skip";
      skip.textContent = getString("interactive-skip");
      skip.addEventListener("click", () => {
        skipped = true;
        capture?.close();
        win.close();
      });
      toolbar.append(instructions, article, status, retry, skip);
      doc.documentElement!.insertBefore(toolbar, doc.getElementById("browser"));
      const browser = doc.querySelector("browser") as any;
      capture = new BrowserPDFCapture(browser);
      (win as any).loadURI(Services.io.newURI(url.href), viewerOptions);
      while (
        !state.cancelled &&
        !win.closed &&
        !skipped &&
        Date.now() < deadline
      ) {
        if (capture.pending) {
          const captured = capture.pending;
          status.textContent = getString("interactive-saving");
          try {
            let timeoutID: number | undefined;
            const timeout = new Promise<never>((_resolve, reject) => {
              timeoutID = win.setTimeout(() => {
                capture?.abortPending();
                reject(new Error("PDF response timed out"));
              }, 60000);
            });
            const result = await Promise.race([captured, timeout]).finally(
              () => {
                if (timeoutID !== undefined) win.clearTimeout(timeoutID);
              },
            );
            if (state.cancelled) return;
            if (skipped) throw new Error("Interactive mirror skipped");
            if (win.closed) return;
            await Utils.attachPDFBytes(result.bytes, item, state);
            completed = !state.cancelled;
            return;
          } catch (error) {
            if (state.cancelled) return;
            if (skipped) throw new Error("Interactive mirror skipped");
            if (win.closed) return;
            status.textContent = getString("interactive-save-failed", {
              args: { error: String(error) },
            });
            const previousRetry = captureRetry;
            // Keep errors visible; Retry reuses bytes after an import failure.
            while (
              captureRetry === previousRetry &&
              capture.pending === captured &&
              !state.cancelled &&
              !win.closed &&
              !skipped &&
              Date.now() < deadline
            )
              await Zotero.Promise.delay(500);
            continue;
          }
        }
        const browser = doc.querySelector("browser") as any;
        const pageURL = browser?.currentURI?.spec as string | undefined;
        if (pageURL && /^https?:\/\//i.test(pageURL)) {
          try {
            let page = browser.contentDocument as Document | null;
            if (!page) {
              const actor =
                browser.browsingContext?.currentWindowGlobal?.getActor(
                  "PageData",
                );
              if (actor) {
                const markup = await Promise.race([
                  actor.sendQuery("documentHTML"),
                  Zotero.Promise.delay(1500).then(() => undefined),
                ]);
                if (markup) {
                  const Parser = ztoolkit.getGlobal("DOMParser");
                  page = new Parser().parseFromString(markup, "text/html");
                }
              }
            }
            if (browser.currentURI.spec !== pageURL) continue;
            // Prefer the actual response stream if a PDF navigation started
            // while the remote document snapshot was being read.
            if (capture.pending) continue;
            const pdf = findPDFURL(page, pageURL);
            const key = pdf ? `${pageURL}\n${pdf.href}` : "";
            if (pdf && key !== lastAttempt) {
              lastAttempt = key;
              status.textContent = getString("interactive-saving");
              try {
                await save(pdf, pageURL);
                completed = !state.cancelled;
                return;
              } catch (error) {
                if (state.cancelled) return;
                status.textContent = getString("interactive-save-failed", {
                  args: { error: String(error) },
                });
              }
            }
          } catch (error) {
            Zotero.debug(`[Sci-PDF] Waiting for browser: ${String(error)}`);
          }
        }
        await Zotero.Promise.delay(500);
      }
      if (!state.cancelled)
        throw new Error(
          skipped
            ? "Interactive mirror skipped"
            : "Verification window timed out",
        );
    } finally {
      completed = true;
      capture?.close();
      win.removeEventListener("unload", onClose);
      if (!win.closed) win.close();
      this.windows.delete(win);
      if (state.cancelRequest === cancel) state.cancelRequest = undefined;
    }
  }
}
