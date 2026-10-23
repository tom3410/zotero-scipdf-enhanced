export function findPDFURL(
  doc: Document | null | undefined,
  pageURL: string,
): URL | undefined {
  if (!doc) return;
  const candidates = [
    doc.querySelector("#pdf")?.getAttribute("src"),
    doc.querySelector("#pdf")?.getAttribute("data"),
    doc.querySelector('embed[type="application/pdf"]')?.getAttribute("src"),
    doc.querySelector('object[type="application/pdf"]')?.getAttribute("data"),
    doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content"),
  ];
  if (
    doc.contentType === "application/pdf" ||
    doc.querySelector("#viewerContainer .pdfViewer")
  )
    candidates.push(pageURL);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate, pageURL);
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password)
        return url;
    } catch {
      /* Ignore malformed or non-web links. */
    }
  }
}

export function pdfExplicitlyMissing(
  doc: Document | null | undefined,
): boolean {
  const body = doc?.querySelector("body");
  return /Please try to search again using DOI|статья не найдена в базе/i.test(
    String(body?.textContent || body?.innerHTML || ""),
  );
}

export function browserUserAgent(): string | undefined {
  return (
    Zotero as unknown as {
      VersionHeader?: { getPlainFirefoxUA?: () => string };
    }
  ).VersionHeader?.getPlainFirefoxUA?.();
}
