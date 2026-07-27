import { defineConfig, devices } from "@playwright/test";
import path from "path";
import os from "os";

// Playwright validates WebKit's shared-library dependencies using ldd before
// spawning the browser process.  In this Replit / NixOS container several
// required libs (libGLESv2, gst-libav codec plugins) are present in the Nix
// store but are NOT in the ambient LD_LIBRARY_PATH.  We must NOT blindly
// prepend all of REPLIT_LD_LIBRARY_PATH because that path includes a newer
// icu4c (v76) that causes CXXABI_1.3.15 version conflicts with Node itself.
//
// Instead we selectively add only the store paths that contain the missing
// WebKit libs, identified at install time by scanning REPLIT_LD_LIBRARY_PATH
// for known package name substrings.
function webkitExtraLibPaths(): string {
  const replitLibPath = process.env.REPLIT_LD_LIBRARY_PATH ?? "";
  const needed = ["libglvnd", "libGL-", "gst-libav"];
  return replitLibPath
    .split(":")
    .filter((p) => needed.some((n) => p.includes(n)))
    .join(":");
}

const extraLibPaths = webkitExtraLibPaths();
if (extraLibPaths) {
  process.env.LD_LIBRARY_PATH = [extraLibPaths, process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");
}

// Note: the dlopen pre-flight check in node_modules/playwright-core/lib/
// coreBundle.js for WebKit (libGLESv2.so.2, libx264.so) has been patched
// to [] because those libraries are in the Nix store at paths not registered
// in the system ldconfig cache, and ldconfig is called with an absolute path
// making a PATH-based wrapper ineffective.  The ldd-based check still runs
// and is satisfied by LD_LIBRARY_PATH set above.

/**
 * Playwright config for real-browser end-to-end tests.
 *
 * These tests are separate from the vitest suite in `tests/` (node
 * environment only, no DOM). Use this harness for flows that genuinely
 * require a browser: multi-tab/multi-context state sync, window-focus
 * refetch timing, rendered DOM assertions, etc.
 *
 * Run with: npx playwright test
 * See tests-e2e/README.md for setup and usage details.
 */
export default defineConfig({
  testDir: "./tests-e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        // The Nix-installed gst-plugins-bad links against libsoup-2.4, which
        // conflicts with webkit's own bundled libsoup-3.  The inherited env
        // var GST_PLUGIN_SYSTEM_PATH_1_0 points to those plugins, causing
        // webkit to crash at startup.  Clear all gstreamer plugin search
        // paths so the browser uses only its own bundled gstreamer registry.
        launchOptions: {
          env: {
            ...process.env,
            GST_PLUGIN_SYSTEM_PATH_1_0: "",
            GST_PLUGIN_PATH_1_0: "",
          },
        },
      },
    },
  ],
  // The "Start application" Replit workflow already runs `npm run dev` on
  // port 5000. Reuse that server instead of spawning a second one — Vite's
  // dev server config in this project is fixed (see forbidden_changes in
  // AGENTS/replit guidelines) and should not be started twice.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
