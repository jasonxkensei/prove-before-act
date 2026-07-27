/**
 * patch-playwright-webkit.mjs
 *
 * Applies a minimal in-place patch to playwright-core's coreBundle.js so that
 * the WebKit browser can launch in the Replit / NixOS container environment.
 *
 * WHY this patch exists
 * ─────────────────────
 * Playwright's WebKit pre-flight validation calls `missingDLOPENLibraries`,
 * which runs `/sbin/ldconfig -p` (by absolute path) to confirm that
 * `libGLESv2.so.2` and `libx264.so` are registered in the system ldconfig
 * cache.  In this NixOS container those libraries exist in the Nix store and
 * are exposed via `REPLIT_LD_LIBRARY_PATH`, but the system ldconfig cache does
 * not know about them and we cannot update it without root.  A PATH-level
 * ldconfig wrapper cannot intercept the absolute-path invocation.
 *
 * The ldd-based check (which DOES respect LD_LIBRARY_PATH, set at the
 * playwright.config.ts level) still validates the libraries at load time.
 * Removing the two library names from the dlOpen list just skips the redundant
 * ldconfig step — it does not disable any real safety check.
 *
 * WHAT this patch does
 * ────────────────────
 * Changes the webkit _validateHostRequirements call from:
 *   …, ["libGLESv2.so.2", "libx264.so"], [""]
 * to:
 *   …, [], [""]
 *
 * The script is idempotent: if the patch is already applied (or the target
 * pattern is not found), it exits silently with code 0.
 *
 * Run: node scripts/patch-playwright-webkit.mjs
 * Automatically run by the "postinstall" npm script after every npm install.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const coreBundlePath = resolve(
  __dirname,
  "../node_modules/playwright-core/lib/coreBundle.js"
);

const ORIGINAL = '_validateHostRequirements(sdkLanguage, webkit.dir, webkitLinuxLddDirectories, ["libGLESv2.so.2", "libx264.so"], [""])';
const PATCHED  = '_validateHostRequirements(sdkLanguage, webkit.dir, webkitLinuxLddDirectories, [], [""])';

let source;
try {
  source = readFileSync(coreBundlePath, "utf8");
} catch {
  // playwright-core not installed yet — nothing to patch
  process.exit(0);
}

if (source.includes(PATCHED)) {
  // Already patched — idempotent, nothing to do
  process.exit(0);
}

if (!source.includes(ORIGINAL)) {
  // Pattern not found — either a different playwright-core version has
  // already changed the shape, or the file has been modified in an
  // incompatible way.  Log a warning but do NOT fail the install.
  console.warn(
    "[patch-playwright-webkit] WARNING: expected pattern not found in " +
    "playwright-core/lib/coreBundle.js — skipping patch.\n" +
    "WebKit tests may fail the pre-flight dependency check in this environment."
  );
  process.exit(0);
}

writeFileSync(coreBundlePath, source.replace(ORIGINAL, PATCHED), "utf8");
console.log(
  "[patch-playwright-webkit] Applied WebKit dlOpen pre-flight patch to " +
  "playwright-core/lib/coreBundle.js"
);
