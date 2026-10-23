import { assert } from "chai";
import { config } from "../package.json";

describe("settings pane in Zotero", function () {
  this.timeout(20000);
  it("loads, switches to the plugin and shows the editable URL list", async function () {
    const pane = (Zotero.PreferencePanes as any).pluginPanes.find(
      (p: any) => p.pluginID === config.addonID,
    );
    assert.isOk(pane, "plugin pane registered");
    const win = Zotero.Utilities.Internal.openPreferences(
      "zotero-prefpane-general",
    ) as any;
    while (!win.Zotero_Preferences) await Zotero.Promise.delay(50);
    const prefs = win.Zotero_Preferences;
    await prefs.waitForFirstPaneLoad();
    try {
      await Zotero.Promise.delay(150);
      await prefs.navigateToPane(pane.id);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          prefs.panes.get("zotero-prefpane-general").container.hidden &&
          !prefs.panes.get(pane.id).container.hidden
        )
          break;
        await Zotero.Promise.delay(50);
      }
      assert.isTrue(
        prefs.panes.get("zotero-prefpane-general").container.hidden,
        "previous pane hidden",
      );
      const editor = win.document.getElementById(
        "zotero-prefpane-scipdf-scihubUrl",
      );
      assert.isOk(editor, "textarea present");
      assert.equal(editor.localName, "textarea");
      assert.equal(
        editor.dataset.initialized,
        "true",
        "load handler initialized controls",
      );
      assert.isAbove(
        editor.getBoundingClientRect().height,
        200,
        "textarea is visible and tall",
      );
      const button = win.document.getElementById(
        "zotero-prefpane-scipdf-fetchMirrors",
      );
      assert.isOk(button);
      const save = win.document.getElementById(
        "zotero-prefpane-scipdf-saveMirrors",
      );
      const status = win.document.getElementById(
        "zotero-prefpane-scipdf-status",
      );
      editor.value = "https://sci-hub.example/\nhttps://sci-hub.example/";
      save.click();
      await win.document.l10n.translateFragment(status);
      assert.equal(
        editor.value,
        "https://sci-hub.example/{doi}",
        "save removes duplicates",
      );
      assert.equal(status.getAttribute("data-l10n-id"), "scipdf-pref-saved");
      assert.isNotEmpty(status.textContent, "saved status translates");
      const source = win.document.getElementById(
        "zotero-prefpane-scipdf-mirrorSource",
      );
      source.value = "https://source.example/";
      const originalRequest = Zotero.HTTP.request;
      try {
        Zotero.HTTP.request = (async () => ({
          status: 200,
          responseText:
            '<html><body><a href="https://sci-hub.test/">Sci-Hub</a></body></html>',
          responseURL: "https://source.example/",
        })) as any;
        button.click();
        for (let attempt = 0; attempt < 100 && button.disabled; attempt++)
          await Zotero.Promise.delay(25);
        assert.include(
          editor.value,
          "https://sci-hub.test/{doi}",
          "fetch button merges parsed HTML",
        );
        assert.equal(
          editor.value.split("\n").length,
          2,
          "manual address retained",
        );
        await win.document.l10n.translateFragment(status);
        assert.equal(
          status.getAttribute("data-l10n-id"),
          "scipdf-pref-fetch-success",
        );
        assert.isNotEmpty(status.textContent, "fetch status translates");
      } finally {
        Zotero.HTTP.request = originalRequest;
      }
      await prefs.navigateToPane("zotero-prefpane-general");
      await prefs.navigateToPane(pane.id);
      assert.isFalse(
        prefs.panes.get(pane.id).container.hidden,
        "pane reopens after switching away",
      );
    } finally {
      win.close();
    }
  });
});
