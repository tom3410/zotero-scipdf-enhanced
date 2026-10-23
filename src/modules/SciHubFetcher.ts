import { getString } from "../utils/locale";
import { Utils } from "../utils/utils";
import { CustomResolverManager } from "./CustomResolverManager";
import { getPref } from "../utils/prefs";
import { InteractiveBrowser, DownloadState } from "./InteractiveBrowser";
import { browserUserAgent, findPDFURL, pdfExplicitlyMissing } from "./pdfPage";

class PDFNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfNotFoundError";
    Object.setPrototypeOf(this, PDFNotFoundError.prototype);
  }
}

export class SciHubFetcher {
  static async updateItems(
    items: Zotero.Item[],
    skipIfExistPDF: boolean = true,
  ) {
    const filtered: Zotero.Item[] = [];
    for (const item of items) {
      if (!item.isRegularItem()) {
        continue;
      }
      if (!skipIfExistPDF) {
        filtered.push(item);
        continue;
      }
      const attachment = await item.getBestAttachment();
      if (!attachment || !attachment.isPDFAttachment()) {
        filtered.push(item);
      }
    }

    if (filtered.length <= 0) {
      return;
    }

    const state: DownloadState = {
      cancelled: false,
      cancelRequest: undefined as (() => void) | undefined,
    };
    // Do not retry a throttled host again in this batch.
    const throttledHosts = new Set<string>();
    for (const [itemIndex, item] of filtered.entries()) {
      if (state.cancelled) break;
      state.interactiveAttempted = false;
      const scihubUrls = await this.buildSciHubURLs(item);
      if (!scihubUrls.length) {
        Utils.showPopWin(
          getString("popwin-doimissing"),
          item.getDisplayTitle(),
          "fail",
        );
        continue;
      }
      const win = Utils.showPopWin(
        getString("popwin-fetching"),
        item.getDisplayTitle(),
        "default",
        0,
      );
      win.addDescription(getString("popwin-cancelhint"));
      state.onInteractive = () =>
        win.changeLine({
          text: getString("interactive-progress"),
          progress: 0,
        });
      const close = win.win.close.bind(win.win);
      // Zotero's close-on-click calls this method. Programmatic cleanup uses close directly.
      win.win.close = () => {
        state.cancelled = true;
        state.cancelRequest?.();
        close();
      };
      let success = false;
      let allNotFound = true;
      try {
        for (const [mirrorIndex, scihubUrl] of scihubUrls.entries()) {
          if (state.cancelled) break;
          if (throttledHosts.has(scihubUrl.host)) {
            allNotFound = false;
            continue;
          }
          win.changeLine({
            text: getString("popwin-fetchprogress", {
              args: {
                item: itemIndex + 1,
                items: filtered.length,
                mirror: mirrorIndex + 1,
                mirrors: scihubUrls.length,
                host: scihubUrl.host,
                title: item.getDisplayTitle(),
              },
            }),
            progress: (mirrorIndex / scihubUrls.length) * 100,
          });
          try {
            await this.fetchPDF(scihubUrl, item, state);
            success = !state.cancelled;
            // A completed attachment import ends this article's search,
            // including all remaining DOI candidates and mirror URLs.
            break;
          } catch (error) {
            if (state.cancelled) break;
            const status = (error as { status?: number } | null)?.status;
            if (status === 429 || status === 503)
              throttledHosts.add(scihubUrl.host);
            allNotFound &&= error instanceof PDFNotFoundError;
            Zotero.debug(`[Sci-PDF] ${scihubUrl.href}: ${String(error)}`);
          } finally {
            state.cancelRequest = undefined;
          }
        }
      } finally {
        win.win.close = close;
        close();
      }
      if (state.cancelled) {
        Utils.showPopWin(getString("popwin-cancelled"), item.getDisplayTitle());
        break;
      }
      Utils.showPopWin(
        getString(
          success
            ? "popwin-fetchsuccess"
            : allNotFound
              ? "popwin-pdfnotavaliable"
              : "popwin-fetchfailed",
        ),
        item.getDisplayTitle(),
        success ? "success" : "fail",
        5000,
      );
    }
  }

  private static async buildSciHubURLs(item: Zotero.Item): Promise<URL[]> {
    const dois = await Utils.extractDOIs(item);
    const baseURLs = this.baseSciHubURLs;
    const urls: URL[] = [];
    for (const doi of dois) {
      for (const base of baseURLs) {
        try {
          urls.push(new URL(doi, base));
        } catch {
          // skip invalid URLs
        }
      }
    }
    return urls;
  }

  private static get baseSciHubURLs(): string[] {
    const resolvers = CustomResolverManager.shared.customResolvers;
    if (resolvers.length <= 0) {
      return ["https://sci-hub.se/"];
    }
    return resolvers.map((r) => {
      // resolver.url is like "https://sci-hub.se/{doi}", extract the base
      return r.url.replace(/\{doi\}.*$/, "");
    });
  }

  private static async fetchPDF(
    scihubUrl: URL,
    item: Zotero.Item,
    state: DownloadState,
  ) {
    const userAgent = browserUserAgent();
    const xhr = await Zotero.HTTP.request("GET", scihubUrl.href, {
      responseType: "document",
      timeout: 15000,
      errorDelayMax: 0,
      successCodes: false,
      cancellerReceiver: (cancel: () => void) => {
        state.cancelRequest = cancel;
        if (state.cancelled) cancel();
      },
      headers: userAgent ? { "User-Agent": userAgent } : {},
    });
    state.cancelRequest = undefined;
    if (state.cancelled) return;
    const pageURL = xhr.responseURL || scihubUrl.href;
    Zotero.debug(`[Sci-PDF] Page HTTP ${xhr.status}: ${pageURL}`);
    const pdf =
      xhr.status === 200 ? findPDFURL(xhr.responseXML, pageURL) : undefined;
    let failure: unknown = Object.assign(
      new Error(`HTTP ${xhr.status} ${xhr.statusText}`),
      { status: xhr.status },
    );
    if (pdf) {
      try {
        // Preserve the established Zotero attachment importer for ordinary downloads.
        // Interactive retries below use the verified session and PDF validation.
        await Utils.attachRemotePDF(pdf, item);
        return;
      } catch (error) {
        failure = error;
      }
    } else if (xhr.status === 200 && pdfExplicitlyMissing(xhr.responseXML)) {
      throw new PDFNotFoundError(
        "The site explicitly reported that this DOI was not found",
      );
    }
    const mayNeedBrowser =
      xhr.status === 200 || xhr.status === 403 || xhr.status === 503;
    if (
      mayNeedBrowser &&
      getPref("interactiveDownload") !== false &&
      !state.interactiveAttempted
    ) {
      state.interactiveAttempted = true;
      await InteractiveBrowser.fetch(
        scihubUrl,
        item,
        state,
        async (url, browserPageURL) => {
          await Utils.attachRemotePDF(url, item, {
            pageURL: browserPageURL,
            userAgent,
            state,
          });
        },
      );
      return;
    }
    throw failure;
  }
}
