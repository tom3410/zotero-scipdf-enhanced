/** Capture PDF responses only from one verification browser and its frames. */
export interface CapturedPDF {
  bytes: Uint8Array;
  url: string;
}

export class BrowserPDFCapture {
  pending?: Promise<CapturedPDF>;
  private channels = new Set<nsIHttpChannel>();
  private closed = false;
  private failed = false;
  private lastURL?: string;
  private rejectPending?: (error: Error) => void;
  private topics = [
    "http-on-examine-response",
    "http-on-examine-cached-response",
    "http-on-examine-merged-response",
  ];
  private observer = {
    observe: (subject: nsISupports) => {
      try {
        const channel = subject.QueryInterface!(
          Components.interfaces.nsIHttpChannel,
        );
        if (!this.belongsToBrowser(channel) || !this.isPDF(channel)) return;
        // Only one attachment is needed for this article. Suppress duplicate PDF
        // navigations from the same page while its first response is being saved.
        if (this.pending) {
          channel.cancel(Components.results.NS_BINDING_ABORTED);
          return;
        }
        this.capture(channel);
      } catch (error) {
        Zotero.debug(`[Sci-PDF] Response capture: ${String(error)}`);
      }
    },
  };

  constructor(private browser: any) {
    for (const topic of this.topics)
      Services.obs.addObserver(this.observer, topic);
  }

  private belongsToBrowser(channel: nsIHttpChannel): boolean {
    const ids = [
      channel.loadInfo.browsingContextID,
      channel.loadInfo.frameBrowsingContextID,
      channel.loadInfo.targetBrowsingContextID,
    ].filter(Boolean);
    if (!ids.length || this.closed) return false;
    const contains = (context: any): boolean =>
      !!context &&
      (ids.includes(context.id) ||
        Array.from(context.children || []).some(contains));
    // Privileged HTTP requests and other Zotero windows have different contexts.
    return contains(this.browser.browsingContext);
  }

  private isPDF(channel: nsIHttpChannel): boolean {
    if (channel.responseStatus !== 200) return false;
    const type = channel.contentType.toLowerCase().split(";")[0].trim();
    if (type === "application/pdf" || type === "application/x-pdf") return true;
    // Some download endpoints send generic binary content with a PDF filename.
    // HTML challenge pages are deliberately excluded even if the URL ends .pdf.
    if (type !== "application/octet-stream" && type !== "binary/octet-stream")
      return false;
    let disposition = "";
    try {
      disposition = channel.getResponseHeader("Content-Disposition");
    } catch {
      /* optional */
    }
    return (
      /\.pdf(?:["';\s]|$)/i.test(disposition) ||
      /\.pdf(?:[?#]|$)/i.test(channel.URI.spec)
    );
  }

  private capture(channel: nsIHttpChannel) {
    let resolve!: (value: CapturedPDF) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<CapturedPDF>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.failed = false;
    this.lastURL = channel.URI.spec;
    this.rejectPending = (error) => {
      this.failed = true;
      reject(error);
    };
    // The response may fail before the UI loop reaches it.
    void pending.catch(() => {});
    const chunks: Uint8Array[] = [];
    let length = 0;
    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIStreamListener",
        "nsIRequestObserver",
      ]),
      onStartRequest() {},
      onDataAvailable: (
        _request: nsIRequest,
        stream: nsIInputStream,
        _offset: number,
        count: number,
      ) => {
        try {
          const binary = (Components.classes as any)[
            "@mozilla.org/binaryinputstream;1"
          ].createInstance(
            Components.interfaces.nsIBinaryInputStream,
          ) as nsIBinaryInputStream;
          binary.setInputStream(stream);
          const bytes = new Uint8Array(binary.readByteArray(count));
          chunks.push(bytes);
          length += bytes.length;
        } catch (error) {
          this.rejectPending?.(new Error(String(error)));
          channel.cancel(Components.results.NS_BINDING_ABORTED);
        }
      },
      onStopRequest: (_request: nsIRequest, status: number) => {
        this.channels.delete(channel);
        if (this.closed || !Components.isSuccessCode(status)) {
          this.rejectPending?.(
            new Error(`PDF response interrupted (${status})`),
          );
          return;
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        resolve({ bytes, url: channel.URI.spec });
      },
    };
    // Same traceable-channel handoff used by Zotero's MIMETypeHandler. The
    // original listener must be stopped before it can invoke Save As.
    const original = channel.QueryInterface!(
      Components.interfaces.nsITraceableChannel,
    ).setNewListener(listener);
    this.pending = pending;
    this.channels.add(channel);
    try {
      original.onStopRequest(channel, Components.results.NS_BINDING_ABORTED);
    } catch (error) {
      Zotero.debug(`[Sci-PDF] Original PDF listener stopped: ${String(error)}`);
    }
  }

  retry(): string | undefined {
    if (!this.failed) return; // Retry importing received bytes without another download.
    this.pending = undefined;
    this.rejectPending = undefined;
    return this.lastURL;
  }

  abortPending() {
    this.rejectPending?.(new Error("PDF response cancelled or timed out"));
    for (const channel of this.channels)
      channel.cancel(Components.results.NS_BINDING_ABORTED);
    this.channels.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const topic of this.topics)
      Services.obs.removeObserver(this.observer, topic);
    this.abortPending();
  }
}
