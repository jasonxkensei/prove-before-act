---
name: MultiversX contract builds on Replit
description: How to compile MultiversX (sc-meta) WASM contracts on Replit/NixOS, and how VM query struct decoding works
---

# Building MultiversX contracts on Replit

**Rule:** The Nix `rust-stable` module has no wasm stdlib and no `rustup`, and `sc-meta` hard-requires `rustup +toolchain` syntax targeting `wasm32v1-none`. Install rustup in an isolated prefix instead of fighting sc-meta.

**Why:** `sc-meta all build` shells out to `cargo +1.88-x86_64-unknown-linux-gnu build --target=wasm32v1-none`, which only works through rustup shims. Direct `cargo build --target wasm32-unknown-unknown` fails with `can't find crate for core`.

**How to apply:**
1. `installProgrammingLanguage rust-stable` (gives cargo for building sc-meta itself).
2. `cargo install --root /tmp/<tools> multiversx-sc-meta` with `CARGO_HOME=/tmp/...` (never `installLanguagePackages` for a rust *tool* — that adds a stray Cargo.toml/src to the app workspace; revert those if it happens).
3. `curl https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain <ver>` with `RUSTUP_HOME`/`CARGO_HOME` in /tmp, then put its bin first in PATH so sc-meta finds rustup; rustup auto-installs the wasm target on demand.
4. `sc-meta all build` then produces `<contract>/output/<contract>.wasm` + `.abi.json`.

# VM query struct decoding (sdk-core / raw gateway)

**Rule:** A view returning `optional<SomeStruct>` (e.g. get_job_data, get_agent) returns ONE base64 buffer containing the whole nested-encoded struct — not one returnData entry per field. Decode sequentially: u8=1 byte, u64=8 bytes BE, bytes=u32 BE length prefix + data, Address=32 fixed bytes. `variadic<multi<u64,Address>>` views (e.g. get_agent_id) return flat alternating returnData entries.

**Why:** Decoding field-per-entry silently yields "Unknown"/empty values with no error; this bug shipped and was only caught by a live Mainnet smoketest.

**How to apply:** See `StructReader` in server/mx8004.ts. When adding a new view call, check the contract ABI (`output/<name>.abi.json`) for the exact output type before writing the decoder.

# Deploying contracts without mxpy

Plain gateway + @multiversx/sdk-core is enough: deploy tx = data `<codeHex>@0500@0500` (vmType@codeMetadata) to the all-zeros system deploy address (`new Address(Buffer.alloc(32))`), init args appended as extra `@hex` parts. Predict the contract address with `AddressComputer.computeContractAddress(deployer, accountNonce)`. ESDT issue inside a contract costs 0.05 EGLD and completes via async callback — poll the token-id view afterwards.
