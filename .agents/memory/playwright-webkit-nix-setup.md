---
name: Playwright WebKit on Replit/NixOS
description: How to get Playwright's WebKit browser running in the Replit NixOS container — system dep gaps, libsoup2/3 conflict, and the patches required.
---

# Playwright WebKit on Replit/NixOS

## The problem
Playwright's Ubuntu-built WebKit binary requires system libraries not in Replit's default env. Three independent blockers must all be resolved:

1. **Pre-flight `ldconfig -p` check** — `libGLESv2.so.2` and `libx264.so` are in the Nix store but absent from the system `ldconfig` cache. Playwright calls `/sbin/ldconfig` by absolute path so a PATH wrapper can't intercept it.
2. **libsoup2 / libsoup3 conflict** — WebKit 2311 bundles `libsoup-3.0.so.0` in its `sys/lib`. The Nix-installed `gst-plugins-bad` links against `libsoup-2.4`. `GST_PLUGIN_SYSTEM_PATH_1_0` (set by NixOS) causes WebKit to load those plugins at startup, pulling in libsoup2 and crashing.
3. **Many other system libs** — `libgles2`, `freetype`, `fontconfig`, `harfbuzz`, `gstreamer`, `gtk4`, `icu74`, etc. must be installed via `installSystemDependencies` in CodeExecution.

## Fixes applied

### 1. Nix packages (replit.nix)
Install via `installSystemDependencies` in CodeExecution. Key packages:
`gst_all_1.gst-plugins-good`, `gst_all_1.gst-vaapi`, `gst_all_1.gst-plugins-bad`, `gst_all_1.gst-libav`, `gst_all_1.gst-plugins-base`, `gst_all_1.gst-plugins-ugly`, `gst_all_1.gstreamer`, `harfbuzzFull`, `libglvnd`, `libGL`, `libjpeg_turbo`, `libmanette`, `libavif`, `icu74`, `gtk4`, `vulkan-loader`, `graphene`, etc. (see full list in replit.nix)

### 2. Patch node_modules/playwright-core/lib/coreBundle.js
Change the WebKit `_validateHostRequirements` dlOpenLibraries from `["libGLESv2.so.2", "libx264.so"]` to `[]`. These libraries are in the Nix store but not ldconfig-registered; the ldd check (which respects LD_LIBRARY_PATH) already validates them.

Search for: `_validateHostRequirements(sdkLanguage, webkit.dir, webkitLinuxLddDirectories, ["libGLESv2.so.2", "libx264.so"], [""])`
Replace with: `_validateHostRequirements(sdkLanguage, webkit.dir, webkitLinuxLddDirectories, [], [""])`

**Why:** `missingDLOPENLibraries` uses `/sbin/ldconfig -p` (absolute path), ignoring `LD_LIBRARY_PATH`. Nix-store libs can't be registered in the system cache without root.

### 3. playwright.config.ts — webkit project launchOptions
```js
launchOptions: {
  env: {
    ...process.env,
    GST_PLUGIN_SYSTEM_PATH_1_0: "",
    GST_PLUGIN_PATH_1_0: "",
  },
},
```

**Why:** `gst-plugins-bad` links against `libsoup-2.4.so.1`. When WebKit inherits `GST_PLUGIN_SYSTEM_PATH_1_0` pointing to Nix gstreamer plugins, it loads them and gets libsoup2 alongside its own bundled libsoup3, causing a fatal crash.

### 4. playwright.config.ts — process-level LD_LIBRARY_PATH
Add libglvnd and libGL paths so the ldd pre-flight check for WebKit finds libGLESv2:
```js
function webkitExtraLibPaths() {
  const needed = ["libglvnd", "libGL-", "gst-libav"];
  return (process.env.REPLIT_LD_LIBRARY_PATH ?? "")
    .split(":").filter(p => needed.some(n => p.includes(n))).join(":");
}
process.env.LD_LIBRARY_PATH = [webkitExtraLibPaths(), process.env.LD_LIBRARY_PATH]
  .filter(Boolean).join(":");
```

**Why:** Must NOT inject full REPLIT_LD_LIBRARY_PATH (contains newer icu4c → CXXABI_1.3.15 conflict with Node). Only inject the targeted store paths.

## Warning
`node_modules/playwright-core/lib/coreBundle.js` is patched and will be overwritten by `npm install`. The patch must be re-applied after reinstalls.
