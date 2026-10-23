import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { sciHubCustomResolver } from "./CustomResolver";
import { CustomResolverManager } from "./CustomResolverManager";
import { fetchMirrorURLs } from "./MirrorUpdater";
import { normalizeMirrorURL, parseMirrorList } from "./mirrorURLs";

export async function registerPrefsScripts(win: Window) {
  addon.data.prefs = { window: win };
  const doc = win.document;
  const get = <T extends Element>(name: string) =>
    doc.querySelector(`#zotero-prefpane-${config.addonRef}-${name}`) as T;
  const editor = get<HTMLTextAreaElement>("scihubUrl");
  if (editor.dataset.initialized) return;
  editor.dataset.initialized = "true";
  const automatic = get<XUL.Checkbox>("autoDownload");
  const interactive = get<XUL.Checkbox>("interactiveDownload");
  interactive.checked = getPref("interactiveDownload") !== false;
  interactive.addEventListener("command", () =>
    setPref("interactiveDownload", interactive.checked),
  );
  const source = get<HTMLInputElement>("mirrorSource");
  const autoUpdate = get<XUL.Checkbox>("mirrorAutoUpdate");
  const fetchButton = get<HTMLButtonElement>("fetchMirrors");
  const status = get<HTMLElement>("status");
  const lastUpdate = get<HTMLElement>("lastUpdate");
  const manager = CustomResolverManager.shared;
  const localize = (element: Element, id: string, args = {}) => {
    element.setAttribute("data-l10n-id", `${config.addonRef}-${id}`);
    element.setAttribute("data-l10n-args", JSON.stringify(args));
  };
  const showLastUpdate = () => {
    const timestamp = Number(getPref("mirrorLastSuccess"));
    localize(
      lastUpdate,
      timestamp ? "pref-last-update" : "pref-never-updated",
      {
        time: timestamp ? new Date(timestamp).toLocaleString() : "",
      },
    );
  };
  automatic.checked =
    getPref("automaticDownload") ??
    manager.customResolvers[0]?.automatic !== false;
  editor.value = manager.customResolvers.map((r) => r.url).join("\n");
  source.value = getPref("mirrorSourceURL") || "";
  autoUpdate.checked = !!getPref("mirrorAutoUpdate");
  showLastUpdate();

  const save = () => {
    const parsed = parseMirrorList(editor.value);
    if (parsed.invalid.length) {
      localize(status, "pref-invalid-urls", {
        urls: parsed.invalid.join("; "),
      });
      return false;
    }
    // Validate the whole draft before replacing any saved configuration.
    manager.removeAllCustomResolversInZotero();
    manager.appendCustomResolversInZotero(
      parsed.urls.map((url) => sciHubCustomResolver(url, automatic.checked)),
    );
    setPref("automaticDownload", automatic.checked);
    editor.value = parsed.urls.join("\n");
    localize(status, "pref-saved", { count: parsed.urls.length });
    return true;
  };
  const saveSource = () => {
    const value = source.value.trim();
    const normalized = normalizeMirrorURL(value);
    if (value && (!normalized || normalized.includes("{doi}"))) {
      localize(status, "pref-invalid-source");
      return false;
    }
    if (autoUpdate.checked && !value) {
      localize(status, "pref-invalid-source");
      return false;
    }
    if (getPref("mirrorSourceURL") !== (normalized || "")) {
      setPref("mirrorLastAttempt", "0");
      setPref("mirrorLastSuccess", "0");
      showLastUpdate();
    }
    setPref("mirrorSourceURL", normalized || "");
    setPref("mirrorAutoUpdate", autoUpdate.checked);
    return true;
  };
  // A startup fetch may finish while the settings pane is already open.
  doc.addEventListener("scipdf-mirrors-updated", () => {
    const draft = parseMirrorList(editor.value);
    if (!draft.invalid.length) {
      editor.value = parseMirrorList(
        [...draft.urls, ...manager.customResolvers.map((r) => r.url)].join(
          "\n",
        ),
      ).urls.join("\n");
    }
    showLastUpdate();
  });
  editor.addEventListener("change", save);
  get<HTMLButtonElement>("saveMirrors").addEventListener("click", save);
  automatic.addEventListener("command", () => {
    if (!save()) automatic.checked = !automatic.checked;
  });
  source.addEventListener("change", saveSource);
  autoUpdate.addEventListener("command", () => {
    if (!saveSource()) autoUpdate.checked = !autoUpdate.checked;
  });
  fetchButton.addEventListener("click", async () => {
    if (!saveSource() || !source.value.trim()) {
      localize(status, "pref-invalid-source");
      return;
    }
    const requestedSource = getPref("mirrorSourceURL");
    fetchButton.disabled = true;
    localize(status, "pref-fetching");
    setPref("mirrorLastAttempt", String(Date.now()));
    try {
      const urls = await fetchMirrorURLs(requestedSource);
      if (win.closed || !addon.data.alive) return;
      if (
        getPref("mirrorSourceURL") !== requestedSource ||
        normalizeMirrorURL(source.value) !== requestedSource
      ) {
        localize(status, "pref-source-changed");
        return;
      }
      const current = parseMirrorList(editor.value);
      if (current.invalid.length) {
        localize(status, "pref-invalid-urls", {
          urls: current.invalid.join("; "),
        });
        return;
      }
      const merged = parseMirrorList([...current.urls, ...urls].join("\n"));
      editor.value = merged.urls.join("\n");
      if (save()) {
        setPref("mirrorLastSuccess", String(Date.now()));
        showLastUpdate();
        localize(status, "pref-fetch-success", {
          added: merged.urls.length - current.urls.length,
          total: merged.urls.length,
        });
      }
    } catch (error) {
      if (!win.closed)
        localize(status, "pref-fetch-failed", { error: String(error) });
    } finally {
      if (!win.closed) fetchButton.disabled = false;
    }
  });
}
