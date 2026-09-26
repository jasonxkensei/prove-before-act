# Independent PBA HTTP recipient witness

This is a separate Node.js process operated by the recipient. It serves one
configured raw-body `POST` route and does not add a route to the xProof app.
It checks a finalized MultiversX WHY marker using the fixed official network
API adapter before passing the exact received bytes to the partner's acceptance
module. Only after that module resolves successfully does it sign and return a
`202` receipt. It neither executes a payment nor claims a later business
outcome.

## Partner-controlled setup

1. Provision an Ed25519 private key in the recipient's own key-management
   process. Store its PEM outside the application checkout with restrictive
    filesystem/secret-manager access (`0600` or stricter regular file). This service never generates, persists,
   prints, or returns private keys. Register the corresponding raw Ed25519
   public key and configured witness ID with the verifier operator out of band.
    After setting the witness configuration below, run
    `npx tsx examples/pba-http-delivery-witness/show-public-key.ts` **on the
    recipient's machine**. Share only its JSON output after the verifier
    operator has independently confirmed the recipient's control of the HTTPS
    origin. Do not send the private PEM to xProof or paste it into a request.
2. For a digest-only pilot, use the included `pilot-acceptor.ts` and set
   `PBA_WITNESS_STORE_DIR` to an absolute, recipient-owned private directory
   (mode `0700`). It durably records the nonce, body digest, and WHY reference,
   never the raw body; this acceptance **does not** prove any later business
   action. Reservations are atomic across processes and retained across
   restarts. A reservation without an `accepted.json` file after a crash
   requires manual investigation before retrying; never blindly clear a
   possibly accepted nonce.

   For an actual recipient application, replace the pilot module with a
   partner-owned ESM module at an absolute path. It must export
   `async function acceptDelivery({ body, bodyDigest, nonce, whyTxHash,
   recipientOrigin, path })`. Resolve only after the recipient's actual durable
   acceptance has succeeded; throw or return `false` to reject. The `body` is
   the exact raw `Buffer`, not parsed JSON. Do not log it. The module must also
   export `nonceStore`, implementing the service's
   `NonceStore` contract with atomic durable `reserve`, `complete`, and `release`
   operations. The runnable server refuses to start without it.
3. Terminate HTTPS at a TLS reverse proxy controlled by the recipient, route
   only the configured path to the service, and prevent public access to its
   plaintext listener. By default it binds to `127.0.0.1`. Set
   `PBA_WITNESS_TLS_TERMINATED=true` only when that proxy is in place; the
   service itself deliberately does not provide TLS or trust forwarded headers.
   Configure the advertised origin as the exact canonical HTTPS origin used by
   clients, without a path or trailing slash beyond the origin syntax.
4. Run from this repository's root with Node and `tsx` available:

   ```sh
   PBA_WITNESS_ID='recipient-key-v1' \
   PBA_WITNESS_ORIGIN='https://recipient.example' \
   PBA_WITNESS_NETWORK='mainnet' \
   PBA_WITNESS_PRIVATE_KEY_FILE='/secure/path/recipient-ed25519.pem' \
    PBA_WITNESS_ACCEPT_MODULE='./examples/pba-http-delivery-witness/pilot-acceptor.ts' \
    PBA_WITNESS_STORE_DIR='/secure/path/pilot-deliveries' \
   PBA_WITNESS_TLS_TERMINATED=true \
   npx tsx examples/pba-http-delivery-witness/server.ts
   ```

    For an isolated pilot, use `devnet` rather than `mainnet`.
    `PBA_WITNESS_NETWORK` must be `mainnet`, `testnet`, or `devnet`; the URL is
   selected internally and is never supplied by a request. Optional listener
   settings are `PBA_WITNESS_BIND_HOST` (default `127.0.0.1`),
   `PBA_WITNESS_PORT` (default `8787`), and `PBA_WITNESS_PATH` (default
   `/deliveries`).

## Request, replay, and operating limits

Each request must be a `POST` to the exact configured path and include one
`x-pba-nonce` header (16–128 allowed characters) and one
`x-pba-why-tx-hash` header (64 hex characters). The witness independently
looks up that hash on the configured MultiversX network and requires the
finalized transaction hash/network and `PBA-VERIFIED-V1|WHY|sha256:<digest>`
marker. Pending, unsupported, mismatched, or unavailable evidence fails
without calling the acceptance module or issuing a receipt. No body parser is
used; SHA-256 is computed over the received bytes, with a hard 256 KiB limit.

The service chooses the receipt's `response_status` (`202`) itself and signs
the canonical `pba-http-delivery-v1` statement. It does not accept a producer
status or digest. The response is sent only after the acceptance callback and
nonce-store completion succeed. Error responses contain no receipt. The service
does not log request bodies or header values; configure the reverse proxy,
application sink, process supervisor, and tracing stack not to log sensitive
body data either.

The built-in nonce store is process-local and exists for isolated use of the
service factory in tests/development; the runnable server requires the
partner's atomic durable nonce store, which must reject already-reserved as
well as completed nonces across process instances. Bind acceptance to that
same nonce idempotently: no generic HTTP service can atomically roll back a
recipient-side effect if the process or storage fails between acceptance and
receipt delivery. Monitor clock accuracy and chain API reachability. A valid
receipt attests only that the configured recipient callback accepted these
bytes after the observed finalized WHY commitment; it does not prove
subsequent processing or execution.