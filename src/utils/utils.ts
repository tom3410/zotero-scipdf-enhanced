import { matchDOIs } from "./identifierPatterns";
import type { DownloadState } from "../modules/InteractiveBrowser";

export class Utils {
  static async extractDOIs(item: Zotero.Item): Promise<string[]> {
    // A valid explicit DOI takes precedence over references in title/extra.
    const explicitDOI = item.getField("DOI");
    if (typeof explicitDOI === "string") {
      const matches = matchDOIs(explicitDOI.trim());
      if (matches.length) return matches;
    }
    const dois: string[] = [];

    const extract = (text: string) => {
      for (const doi of matchDOIs(text)) {
        if (!dois.some((value) => value.toLowerCase() === doi.toLowerCase())) {
          dois.push(doi);
        }
      }
    };

    const extractFromItem = (it: Zotero.Item) => {
      for (const field of ["DOI", "url", "title", "extra"] as const) {
        const value = it.getField(field);
        if (value && typeof value === "string") {
          extract(value);
        }
      }
    };

    extractFromItem(item);
    for (const attachment of await item.getBestAttachments()) {
      extractFromItem(attachment);
    }
    return dois;
  }

  static async attachRemotePDF(
    pdfURL: URL,
    item: Zotero.Item,
    context?: { pageURL: string; userAgent?: string; state: DownloadState },
  ) {
    if (context) {
      const { state, pageURL, userAgent } = context;
      if (state.cancelled) return;
      const previousCancel = state.cancelRequest;
      try {
        const xhr = await Zotero.HTTP.request("GET", pdfURL.href, {
          responseType: "arraybuffer",
          timeout: 60000,
          errorDelayMax: 0,
          successCodes: false,
          headers: {
            Referer: pageURL,
            ...(userAgent ? { "User-Agent": userAgent } : {}),
          },
          cancellerReceiver: (cancel: () => void) => {
            state.cancelRequest = cancel;
            if (state.cancelled) cancel();
          },
        });
        if (state.cancelled) return;
        if (xhr.status !== 200) throw new Error(`PDF HTTP ${xhr.status}`);
        await this.attachPDFBytes(
          new Uint8Array(xhr.response as ArrayBuffer),
          item,
          state,
        );
        return;
      } finally {
        state.cancelRequest = previousCancel;
      }
    }
    const filename = pdfURL.pathname.split("/").pop() || null;
    const importOptions = {
      libraryID: item.libraryID,
      url: pdfURL.href,
      parentItemID: item.id,
      title: item.getField("title"),
      fileBaseName: filename,
      contentType: "application/pdf",
      referrer: "",
      cookieSandbox: null,
    };
    ztoolkit.log(
      `Import Options: ${JSON.stringify(importOptions, null, "\t")}`,
    );
    await Zotero.Attachments.importFromURL(importOptions);
  }

  static async attachPDFBytes(
    bytes: Uint8Array,
    item: Zotero.Item,
    state: DownloadState,
  ) {
    if (state.cancelled) return;
    if (!String.fromCharCode(...bytes.subarray(0, 1024)).includes("%PDF-"))
      throw new Error(
        "The server returned a verification page or other non-PDF content",
      );
    const directory =
      await Zotero.Attachments.createTemporaryStorageDirectory();
    try {
      // nsIFile appends with the native separator, including Windows Unicode paths.
      const file = directory.clone();
      file.append("article.pdf");
      const path = file.path;
      await ztoolkit.getGlobal("IOUtils").write(path, bytes);
      if (state.cancelled) return;
      await Zotero.Attachments.importFromFile({
        file: path,
        libraryID: item.libraryID,
        parentItemID: item.id,
        title: String(item.getField("title") || "PDF"),
        contentType: "application/pdf",
      });
    } finally {
      try {
        await ztoolkit
          .getGlobal("IOUtils")
          .remove(directory.path, { recursive: true, ignoreAbsent: true });
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  static showPopWin(
    title: string,
    message: string,
    type?: "fail" | "success" | "default",
    closeTime: number = 3000,
  ) {
    const win = new ztoolkit.ProgressWindow(title, {
      closeOnClick: true,
      closeTime: closeTime,
    }).createLine({
      text: message,
      type: type,
      progress: 0,
    });
    win.show(closeTime);
    return win;
  }
}
