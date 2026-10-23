/** Normalize a base URL or an existing resolver template. */
export function normalizeMirrorURL(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      return undefined;
    return url.href.replace(/%7Bdoi%7D/gi, "{doi}");
  } catch {
    return undefined;
  }
}

export function parseMirrorList(value: string) {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const entry of value.split(/[\s;,，；、]+/).filter(Boolean)) {
    const normalized = normalizeMirrorURL(entry);
    if (
      !normalized ||
      (!normalized.includes("{doi}") &&
        (new URL(normalized).search || new URL(normalized).hash))
    ) {
      invalid.push(entry);
      continue;
    }
    const template = normalized.includes("{doi}")
      ? normalized
      : `${normalized.replace(/\/$/, "")}/{doi}`;
    if (!urls.includes(template)) urls.push(template);
  }
  return { urls, invalid };
}

/** Read inert page content only. No remote scripts or handlers are executed. */
export function extractMirrorURLs(doc: Document, sourceURL: string): string[] {
  const urls = new Set<string>();
  const sourceOrigin = new URL(sourceURL).origin;
  const add = (value: string, labelled = false) => {
    try {
      const normalized = normalizeMirrorURL(new URL(value, sourceURL).href);
      if (!normalized) return;
      const url = new URL(normalized);
      const named = /^(?:www\.)?sci-?hub(?:\.[a-z0-9-]+)+$/i.test(url.hostname);
      if (!named && !labelled) return;
      // Only import homepages, never article, redirect or tracking URLs.
      if (url.search || url.hash || !/^\/(?:\{doi\})?$/.test(url.pathname))
        return;
      if (url.origin !== sourceOrigin) urls.add(`${url.origin}/`);
    } catch {
      // Ignore malformed and unsupported links in the source page.
    }
  };
  for (const link of doc.querySelectorAll("a[href]")) {
    add(
      link.getAttribute("href") || "",
      /sci[\s-]?hub/i.test(link.textContent || ""),
    );
  }
  const text = doc.body?.textContent || "";
  for (const match of text.matchAll(
    /https?:\/\/[^\s<>"'`\\，；、）)\]】}]+/gi,
  )) {
    add(match[0].replace(/[.,;:!?。]+$/, ""));
  }
  return [...urls];
}
