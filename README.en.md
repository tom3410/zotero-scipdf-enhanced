# Sci-PDF Enhanced for Zotero

[中文](README.md) | **English**

**Manage mirror URLs in bulk, complete verification when needed, and save downloaded PDFs directly to your Zotero items.**

Maintained by [tom3410](https://github.com/tom3410), based on [syt2/zotero-scipdf](https://github.com/syt2/zotero-scipdf). This version keeps the original PDF retrieval feature and improves URL management, redirects, and downloads after verification. It first tries to download in the background. If a page requires verification or cannot be parsed directly, you can open it in a Zotero window. Once the PDF is received, it is attached to the item that started the download.

## Features

- **Larger URL editor**: Supports multiple lines, scrolling, and resizing. Enter one URL per line to add, edit, or remove mirrors in bulk. Older separator formats are supported, and duplicates are removed on save.
- **Import mirrors from a source page**: Enter a source page URL to fetch and merge mirror addresses while keeping your existing entries. An optional startup check runs at most once every 24 hours.
- **Background downloads**: PDFs that can be retrieved directly are saved to the corresponding item without opening a web window.
- **Continue after manual verification**: When a download is blocked, open a Zotero web window to complete verification or search by DOI. The plugin captures PDFs returned by that window, including responses that would otherwise trigger a file download.
- **Attach PDFs to the original item**: PDFs received after verification are imported directly into the item that started the download.
- **Stop after success**: Once a PDF is saved, the plugin stops trying other mirrors for that item. Batch downloads move on to the next item.
- **Skip, retry, or cancel**: Skip the current mirror, retry saving, or close the verification window to cancel the batch.
- **Windows path support**: Temporary file paths use native file APIs, including when the data directory contains Chinese characters.

## Installation

1. Download the `.xpi` package from [Releases](https://github.com/tom3410/zotero-scipdf-enhanced/releases).
2. In Zotero, open **Tools → Plugins → gear menu → Install Plugin From File**, then select the downloaded XPI file.
3. Quit Zotero completely and restart it.

This version uses the original plugin ID, so it replaces the original plugin and reuses its settings. The two versions cannot be enabled together. Starting with **8.1.3.8**, packages built from this repository check this repository for updates. If you are switching from an earlier package, install the new version manually once.

## Usage

1. Open the **Sci-PDF / PDF下载** page in Zotero settings. Enter one mirror URL per line and save.
2. Select your items, right-click, and choose this plugin's **Get PDF (获取PDF)** command. This is separate from Zotero's **Find Full Text (查找全文)** command.
3. The plugin first tries to download in the background. A successful download appears as a PDF attachment under the selected item.
4. If a web window opens, complete verification in that window.
5. The window closes once the PDF has been received and saved. If saving fails, click **Verification complete, retry saving (验证完成，重试保存)**. **Skip this mirror (跳过此镜像)** continues with other mirrors; closing the window cancels the batch.

To import mirror addresses, enter the full source page URL in settings and click **Fetch and add now (立即获取并添加)**. An address found on a source page is not necessarily available.

## Notes and limitations

- Items need a recognizable DOI, and the site needs to have the full text. Not every paper can be downloaded.
- A web window may open because of verification, an unrecognized page structure, or a script-based redirect.
- Verification must be completed manually. Login and verification sessions from an external browser are not automatically shared with Zotero.
- Custom readers, `blob:` URLs, and sites that reject embedded browsers may need further support.
- The project targets Zotero 7 and later. Focused runtime tests have been performed on Linux with Zotero 9.0.6, and path handling has been fixed based on Windows user feedback. Not every combination of operating system and site has been tested.

## Build from source

Requires Node.js and npm. Dependency versions are pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm run test:unit
npm run build
npm run test:package
```

The package is generated at `.scaffold/build/sci-pdf-enhanced.xpi`. Update metadata is written to `update.json` and `update-beta.json` in the same directory.

Tests cover mirror settings, the download queue, stopping after a successful download, PDF response capture in the verification window, attachment imports, and Windows paths containing Chinese characters. Native tests require a separate Zotero test environment. See the [enhanced version guide (Chinese)](doc/ENHANCED-zhCN.md) for instructions.

## Acknowledgments and license

Thanks to [syt2](https://github.com/syt2) for the original [zotero-scipdf](https://github.com/syt2/zotero-scipdf), and to [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) and the related plugin template projects.

This version retains the original author credits and is licensed under **AGPL-3.0-or-later**. See [LICENSE](LICENSE) for the full terms. Please submit bugs and suggestions to [this repository's Issues](https://github.com/tom3410/zotero-scipdf-enhanced/issues).
