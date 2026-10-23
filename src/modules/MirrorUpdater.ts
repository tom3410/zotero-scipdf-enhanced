import { getPref, setPref } from "../utils/prefs";
import { sciHubCustomResolver } from "./CustomResolver";
import { CustomResolverManager } from "./CustomResolverManager";
import {
  extractMirrorURLs,
  normalizeMirrorURL,
  parseMirrorList,
} from "./mirrorURLs";

export async function fetchMirrorURLs(source: string): Promise<string[]> {
  const url = normalizeMirrorURL(source);
  if (!url || url.includes("{doi}")) throw new Error("Invalid source URL");
  const xhr = await Zotero.HTTP.request("GET", url, {
    responseType: "text",
    timeout: 15000,
    errorDelayMax: 0,
    successCodes: false,
    noCache: true,
  });
  if (xhr.status < 200 || xhr.status >= 300)
    throw new Error(`HTTP ${xhr.status}`);
  const text = xhr.responseText || "";
  if (text.length > 2_000_000) throw new Error("Source page too large");
  const Parser = ztoolkit.getGlobal("DOMParser");
  const doc = new Parser().parseFromString(text, "text/html");
  const urls = extractMirrorURLs(doc, xhr.responseURL || url);
  if (!urls.length) throw new Error("No Sci-Hub homepage links found");
  return urls;
}

/** Opt-in, at most once per 24 hours on startup; failures preserve saved URLs. */
export async function refreshMirrorsIfDue() {
  const source = getPref("mirrorSourceURL");
  if (!getPref("mirrorAutoUpdate") || !source) return;
  const lastAttempt = Number(getPref("mirrorLastAttempt") || 0);
  const now = Date.now();
  if (lastAttempt <= now && now - lastAttempt < 86_400_000) return;
  setPref("mirrorLastAttempt", String(now));
  try {
    const urls = await fetchMirrorURLs(source);
    if (
      !addon.data.alive ||
      !getPref("mirrorAutoUpdate") ||
      getPref("mirrorSourceURL") !== source
    )
      return;
    const manager = CustomResolverManager.shared;
    const automatic =
      getPref("automaticDownload") ??
      manager.customResolvers[0]?.automatic !== false;
    // Read after the request so concurrent saved edits are retained.
    const existing = new Set(
      parseMirrorList(manager.customResolvers.map((r) => r.url).join("\n"))
        .urls,
    );
    manager.appendCustomResolversInZotero(
      parseMirrorList(urls.join("\n"))
        .urls.filter((url) => !existing.has(url))
        .map((url) => sciHubCustomResolver(url, automatic)),
    );
    setPref("mirrorLastSuccess", String(Date.now()));
    const win = addon.data.prefs?.window;
    if (win && !win.closed) {
      const event = win.document.createEvent("Event");
      event.initEvent("scipdf-mirrors-updated", false, false);
      win.document.dispatchEvent(event);
    }
  } catch (error) {
    Zotero.debug(`[Sci-PDF] Mirror update failed: ${String(error)}`);
  }
}
