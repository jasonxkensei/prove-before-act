---
name: "@noble/ed25519 v3 breaking change: no more etc monkeypatching"
description: v3 of @noble/ed25519 freezes the `etc` config object and ships built-in async hashing, so the common v1/v2 pattern of monkeypatching `ed.etc.sha512Sync` breaks at runtime.
---

`@noble/ed25519` v1/v2 required consumers to manually wire a SHA-512 implementation via `ed.etc.sha512Sync = ...` (or `.sha512Async`) before signing/verifying. In v3, `etc` is frozen (`Object.isExtensible(ed.etc) === false`), so that assignment throws `Cannot add property sha512Sync, object is not extensible` — and it's no longer needed, since v3 ships built-in async hashing.

**Why:** A routine dependency-vulnerability bump pulled in v3 transitively and silently broke every call site still doing the old monkeypatch, with no compile-time signal — only surfaced as runtime signing failures in blockchain write paths and MCP tools.

**How to apply:** When bumping `@noble/ed25519` (directly or transitively) across a major version, grep the codebase for `@noble/ed25519` imports and for any `ed.etc.sha512` assignment. Remove the monkeypatch and use `ed.signAsync`/`ed.verifyAsync` (or the sync variants only if you deliberately re-wire `ed.hashes.sha512` per the v3 docs). Sync `ed.sign()`/`ed.verify()` in v3 throw `hashes.sha512 not set` unless you do this.
