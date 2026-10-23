const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const AdmZip = require("adm-zip");
const pkg = require("../package.json");

function validateXPI(file) {
  const zip = new AdmZip(file);
  const manifest = JSON.parse(zip.readAsText("manifest.json"));
  const application = manifest.applications?.zotero;
  // Zotero's Extension.sys.mjs rejects missing id, update_url, strict_max_version.
  for (const key of ["id", "update_url", "strict_max_version"]) {
    assert.ok(application?.[key], `applications.zotero.${key} not provided`);
  }
  assert.equal(manifest.manifest_version, 2);
  assert.equal(application.id, pkg.config.addonID);
  assert.equal(new URL(application.update_url).protocol, "https:");
  assert.equal(application.strict_min_version, "6.999");
  assert.equal(application.strict_max_version, "10.*");
  assert.equal(manifest.version, pkg.version);
  assert.ok(
    zip.getEntry("bootstrap.js"),
    "missing bootstrap.js at archive root",
  );
  assert.ok(
    zip.getEntry("content/scripts/scipdf.js"),
    "missing bundled script",
  );
  assert.ok(
    zip.getEntry("content/preferences.xhtml"),
    "missing preference pane",
  );
  for (const name of [
    "manifest.json",
    "bootstrap.js",
    "content/preferences.xhtml",
  ]) {
    assert.doesNotMatch(
      zip.readAsText(name),
      /__(?:addon\w+|updateURL|buildVersion)__/,
    );
  }
  return manifest;
}

test("packed XPI contains Zotero-required fields and resolved runtime files", () => {
  validateXPI(path.join(__dirname, "../.scaffold/build/sci-pdf-enhanced.xpi"));
});

test("missing update_url is rejected before distributing a package", () => {
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        applications: {
          zotero: { id: pkg.config.addonID, strict_max_version: "10.*" },
        },
      }),
    ),
  );
  assert.throws(() => validateXPI(zip.toBuffer()), /update_url not provided/);
});

const previous = path.join(
  __dirname,
  "../../output/Sci-PDF-Enhanced-8.1.3.1.xpi",
);
if (fs.existsSync(previous)) {
  test("previous failing release is caught by the install-field regression check", () => {
    assert.throws(() => validateXPI(previous), /update_url not provided/);
  });
}

test("built package points its homepage and update service to the maintained fork", () => {
  const repo = new URL(
    pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""),
  );
  const manifest = validateXPI(
    path.join(__dirname, "../.scaffold/build/sci-pdf-enhanced.xpi"),
  );
  assert.equal(repo.pathname, "/tom3410/zotero-scipdf-enhanced");
  assert.equal(manifest.homepage_url, `${repo.href}#readme`);
  assert.equal(
    manifest.applications.zotero.update_url,
    `${repo.href}/releases/download/release/update.json`,
  );
});

test("update metadata references this repository's versioned XPI and matches its actual hash", () => {
  const crypto = require("node:crypto");
  const build = path.join(__dirname, "../.scaffold/build");
  const metadata = JSON.parse(
    fs.readFileSync(path.join(build, "update.json"), "utf8"),
  );
  const update = metadata.addons[pkg.config.addonID].updates.find(
    (entry) => entry.version === pkg.version,
  );
  assert.ok(update);
  assert.equal(
    update.update_link,
    `https://github.com/tom3410/zotero-scipdf-enhanced/releases/download/V${pkg.version}/sci-pdf-enhanced.xpi`,
  );
  const bytes = fs.readFileSync(path.join(build, "sci-pdf-enhanced.xpi"));
  assert.equal(
    update.update_hash,
    `sha512:${crypto.createHash("sha512").update(bytes).digest("hex")}`,
  );
});
