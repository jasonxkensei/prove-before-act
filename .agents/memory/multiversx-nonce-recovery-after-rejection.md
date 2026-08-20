---
name: MultiversX nonce recovery after transaction rejection
description: Wallet nonce claims can advance locally even when a gateway rejects a transaction.
---

The server claims and persists a MultiversX wallet nonce before it broadcasts a transaction. A gateway rejection that does not consume that nonce (for example, insufficient funds) can leave the persisted nonce ahead of the chain nonce.

**Why:** Repeated failed proof attempts then create nonce gaps. Topping up the wallet alone may not restore processing; future transactions can be sent with a too-high nonce, while failed MX-8004 validation jobs stay terminal.

**How to apply:** During a signer-funding or network-migration recovery, compare the persisted wallet nonce with the active chain's account nonce, resync the persisted value after definitively rejected broadcasts, then retry only the affected background jobs after the signer is funded. Keep the MX-8004 agent nonce configuration separate: it identifies the validation agent and does not own API keys.