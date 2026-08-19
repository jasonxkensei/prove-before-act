/**
 * Live end-to-end verification of the partner API field changes.
 *
 * The SIGIL, BNB, ElizaOS, xAI, and MPP endpoints return pba_* primary fields
 * alongside deprecated xproof_* aliases. These tests call every endpoint over
 * HTTP against the running server and assert:
 *   (a) both field sets are present,
 *   (b) each pba_* field and its xproof_* alias have identical values,
 *   (c) integrators still reading the old xproof_* keys receive real values
 *       (not null/missing) when an identity is actually linked.
 *
 * Both the linked path (seeded public-profile user + certifications carrying
 * the partner metadata keys) and the unlinked path (unknown identifiers) are
 * exercised, since the alias wiring is duplicated per branch in
 * server/routes/proof-read.ts and either copy can drift independently.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { pool } from "../server/db";

const BASE = process.env.TEST_BASE_URL || "http://127.0.0.1:5000";

// ── Seeded identifiers (unique per run so reruns never collide) ─────────────
const RUN = crypto.randomBytes(6).toString("hex");
const SIGIL_KEY = `pba-parity-sigil-${RUN}`;
const BNB_ADDR = `0x${crypto.randomBytes(20).toString("hex")}`;
const ELIZA_UUID = crypto.randomUUID();
const XAI_AGENT_ID = `pba-parity-xai-${RUN}`;
const MPP_PI = `pi_pbaparity_${RUN}`;
// Synthetic but format-valid MultiversX wallet (erd1 + 58 lowercase base32-ish chars)
const WALLET = `erd1${crypto.randomBytes(29).toString("hex").slice(0, 58)}`;

let userId: string;
const certIds: string[] = [];

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function seedCert(metadata: Record<string, unknown>, tag: string) {
  const r = await pool.query(
    `INSERT INTO certifications (user_id, file_name, file_hash, blockchain_status, is_public, metadata)
     VALUES ($1, $2, $3, 'confirmed', true, $4::jsonb)
     RETURNING id`,
    [userId, `pba-parity-${tag}.json`, sha256(`pba-parity-${RUN}-${tag}`), JSON.stringify(metadata)],
  );
  certIds.push(r.rows[0].id);
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  expect(res.status, `GET ${path}`).toBe(200);
  return res.json();
}

/**
 * Recursively walk the response: at EVERY object level, each key starting
 * with pba_ must have an xproof_-prefixed sibling that deep-equals it, and
 * every "prove-before-act" key must have an identical "xproof" sibling.
 * Returns the number of alias pairs verified so callers can assert coverage.
 */
function checkAliasParity(node: any, endpoint: string, path = "$"): number {
  if (node === null || typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    return node.reduce((n, item, i) => n + checkAliasParity(item, endpoint, `${path}[${i}]`), 0);
  }
  let pairs = 0;
  for (const key of Object.keys(node)) {
    let aliasKey: string | null = null;
    if (key.startsWith("pba_")) aliasKey = key.replace(/^pba_/, "xproof_");
    else if (key === "prove-before-act") aliasKey = "xproof";
    if (aliasKey !== null) {
      expect(aliasKey in node, `${endpoint}: ${path}.${key} has no legacy alias ${path}.${aliasKey}`).toBe(true);
      expect(node[aliasKey], `${endpoint}: ${path}.${aliasKey} must equal ${path}.${key}`).toEqual(node[key]);
      pairs++;
    }
    pairs += checkAliasParity(node[key], endpoint, `${path}.${key}`);
  }
  return pairs;
}

/** Assert the response contains pba_* fields and full recursive alias parity. */
function expectAliasParity(body: Record<string, any>, endpoint: string) {
  const pairs = checkAliasParity(body, endpoint);
  expect(pairs, `${endpoint} must expose pba_*/prove-before-act fields with aliases`).toBeGreaterThan(0);
}

beforeAll(async () => {
  const u = await pool.query(
    `INSERT INTO users (wallet_address, is_public_profile, agent_name)
     VALUES ($1, true, $2)
     RETURNING id`,
    [WALLET, `pba-parity-test-${RUN}`],
  );
  userId = u.rows[0].id;

  // Trust scores are read exclusively from trust_score_snapshots (populated by
  // a scheduled refresh in production), so seed a snapshot for the test wallet
  // to exercise the non-null trust path old integrators depend on.
  const trustData = {
    score: 150,
    level: "Active",
    certTotal: 5,
    certLast30d: 5,
    streakWeeks: 2,
    activeAttestations: 0,
    attestationBonus: 0,
    transparencyTier: "Tier 1",
    transparencyBonus: 0,
    metadataCount: 5,
    auditCount: 0,
    firstCertAt: null,
    lastCertAt: null,
    violationPenalty: 0,
    violations: { fault: 0, breach: 0, proposed: 0 },
  };
  await pool.query(
    `INSERT INTO trust_score_snapshots
       (wallet_address, score, level, cert_total, active_attestations, snapshot_date, full_trust_data)
     VALUES ($1, $2, $3, $4, 0, CURRENT_DATE, $5::jsonb)
     ON CONFLICT (wallet_address, snapshot_date) DO UPDATE
       SET full_trust_data = EXCLUDED.full_trust_data,
           score = EXCLUDED.score,
           level = EXCLUDED.level,
           cert_total = EXCLUDED.cert_total`,
    [WALLET, trustData.score, trustData.level, trustData.certTotal, JSON.stringify(trustData)],
  );

  await Promise.all([
    seedCert({ sigil_public_key: SIGIL_KEY, sigil_persistence_score: 87, receipt_count: 3 }, "sigil"),
    seedCert({ bnb_wallet: BNB_ADDR }, "bnb"),
    seedCert(
      { eliza_agent_id: ELIZA_UUID, eliza_character_name: "ParityBot", eliza_session_id: `s-${RUN}`, action_type: "reason", eliza_runtime: "1.0.0" },
      "eliza",
    ),
    seedCert(
      { xai_agent_id: XAI_AGENT_ID, xai_model: "grok-3", xai_session_id: `x-${RUN}`, action_type: "generate" },
      "xai",
    ),
    seedCert({ mpp_payment_intent_id: MPP_PI, mpp_amount: "12.50", mpp_currency: "usd", mpp_network: "tempo" }, "mpp"),
  ]);
});

afterAll(async () => {
  if (certIds.length > 0) {
    await pool.query(`DELETE FROM certifications WHERE id = ANY($1)`, [certIds]);
  }
  await pool.query(`DELETE FROM trust_score_snapshots WHERE wallet_address = $1`, [WALLET]);
  if (userId) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
});

// ── Linked identities: aliases must carry real (non-null) values ────────────

describe("partner pba_*/xproof_* alias parity — linked identities", () => {
  it("SIGIL: linked response has equal pba_*/xproof_* values and non-null legacy fields", async () => {
    const body = await getJson(`/api/sigil/${SIGIL_KEY}`);
    expect(body.pba_linked).toBe(true);
    expectAliasParity(body, "/api/sigil");
    // Old integrators must keep receiving real values through legacy keys
    expect(body.xproof_linked).toBe(true);
    expect(body.xproof_wallet).toBe(WALLET);
    expect(body.xproof_certs_linked).toBeGreaterThanOrEqual(1);
    expect(body.xproof_trust_score).not.toBeNull();
    expect(body.xproof_violations).not.toBeNull();
    // Nested legacy aliases
    expect(body.convergence.xproof_anchors).toEqual(body.convergence.pba_anchors);
    expect(body.verify_urls.xproof_leaderboard).toEqual(body.verify_urls.pba_leaderboard);
    expect(body.verify_urls.xproof_profile).toEqual(body.verify_urls.pba_profile);
    expect(body.verify_urls.xproof_violations).toEqual(body.verify_urls.pba_violations);
  });

  it("BNB: linked response has equal pba_*/xproof_* values including on-chain counts", async () => {
    const body = await getJson(`/api/bnb/${BNB_ADDR}`);
    expect(body.pba_linked).toBe(true);
    expectAliasParity(body, "/api/bnb");
    expect(body.xproof_linked).toBe(true);
    expect(body.xproof_wallet).toBe(WALLET);
    expect(body.xproof_certs_linked).toBeGreaterThanOrEqual(1);
    expect(body.xproof_certs_confirmed_on_chain).toBeGreaterThanOrEqual(1);
    expect(body.xproof_trust_score).not.toBeNull();
    expect(body.links.xproof_profile).toEqual(body.links.pba_profile);
    expect(body.links.xproof_leaderboard).toEqual(body.links.pba_leaderboard);
  });

  it("ElizaOS: linked response returns identical prove-before-act and xproof objects", async () => {
    const body = await getJson(`/api/eliza/${ELIZA_UUID}`);
    expect(body.lookup_mode).toBe("character_id");
    expect(body.eliza_linked).toBe(true);
    // Recursive parity covers "prove-before-act"/"xproof" plus nested aliases
    // (convergence.pba_anchors/xproof_anchors, plugin_config.pba_api/xproof_api, ...)
    expectAliasParity(body, "/api/eliza");
    // Alias must be a real object with real values, not null, for old integrators
    expect(body["prove-before-act"]).not.toBeNull();
    expect(body.xproof.wallet).toBe(WALLET);
    expect(body.xproof.trust_score).not.toBeNull();
    expect(body.character?.character_name).toBe("ParityBot");
  });

  it("xAI: linked response returns identical prove-before-act and xproof objects", async () => {
    const body = await getJson(`/api/xai/${XAI_AGENT_ID}`);
    expect(body.lookup_mode).toBe("agent_id");
    expect(body.xai_linked).toBe(true);
    expectAliasParity(body, "/api/xai");
    expect(body["prove-before-act"]).not.toBeNull();
    expect(body.xproof.wallet).toBe(WALLET);
    expect(body.xproof.trust_score).not.toBeNull();
  });

  it("MPP: linked response has equal pba_*/xproof_* values and real payment linkage", async () => {
    const body = await getJson(`/api/mpp/${MPP_PI}`);
    expect(body.mpp_linked).toBe(true);
    expect(body.mpp_amount).toBe("12.50");
    expectAliasParity(body, "/api/mpp");
    expect(body.xproof_wallet).toBe(WALLET);
    expect(body.xproof_certs_linked).toBeGreaterThanOrEqual(1);
    expect(body.xproof_certs_confirmed_on_chain).toBeGreaterThanOrEqual(1);
    expect(body.xproof_trust_score).not.toBeNull();
    expect(body.convergence.xproof_anchors).toEqual(body.convergence.pba_anchors);
    expect(body.links.xproof_profile).toEqual(body.links.pba_profile);
    expect(body.links.xproof_leaderboard).toEqual(body.links.pba_leaderboard);
  });
});

// ── Unlinked identities: both field sets still present, still equal ─────────

describe("partner pba_*/xproof_* alias parity — unlinked identities", () => {
  it("SIGIL: unlinked response still exposes both field sets with equal values", async () => {
    const body = await getJson(`/api/sigil/pba-parity-unlinked-${RUN}`);
    expect(body.pba_linked).toBe(false);
    expectAliasParity(body, "/api/sigil (unlinked)");
  });

  it("BNB: unlinked response still exposes both field sets with equal values", async () => {
    const body = await getJson(`/api/bnb/0x${"0".repeat(39)}1`);
    expect(body.pba_linked).toBe(false);
    expectAliasParity(body, "/api/bnb (unlinked)");
  });

  it("ElizaOS: unlinked response keeps full alias parity including nested keys", async () => {
    const body = await getJson(`/api/eliza/${crypto.randomUUID()}`);
    expect(body.eliza_linked).toBe(false);
    expectAliasParity(body, "/api/eliza (unlinked)");
  });

  it("xAI: unlinked response keeps full alias parity including nested keys", async () => {
    const body = await getJson(`/api/xai/pba-parity-unlinked-${RUN}`);
    expect(body.xai_linked).toBe(false);
    expectAliasParity(body, "/api/xai (unlinked)");
  });

  it("MPP: unlinked response still exposes both field sets with equal values", async () => {
    const body = await getJson(`/api/mpp/pi_pbaparity_unlinked_${RUN}`);
    expect(body.mpp_linked).toBe(false);
    expectAliasParity(body, "/api/mpp (unlinked)");
  });
});
