import { type Express } from "express";
import { pool } from "../db";
import { isWalletAuthenticated } from "../walletAuth";

const HISTORICAL_LABEL = "Agent historique / attribution inconnue";

function iso(value: unknown): string | null {
  return value ? new Date(value as string | Date).toISOString() : null;
}

export function fleetHealth(
  lastSeenAt: Date | string | null,
  failedInTrailing24Hours: number,
  pendingOlderThan15Minutes: number,
  now = Date.now(),
) {
  if (failedInTrailing24Hours > 0) {
    return { health: "red", reasons: ["failed_proof_within_24h"] };
  }
  const stale = !lastSeenAt || new Date(lastSeenAt).getTime() < now - 24 * 60 * 60 * 1000;
  if (stale || pendingOlderThan15Minutes > 0) {
    return {
      health: "orange",
      reasons: [
        ...(stale ? [lastSeenAt ? "last_seen_over_24h" : "no_last_seen_at"] : []),
        ...(pendingOlderThan15Minutes > 0 ? ["pending_proof_over_15m"] : []),
      ],
    };
  }
  return { health: "green", reasons: [] };
}

async function sessionAccountId(req: any): Promise<string | null> {
  const walletAddress: string | undefined = req.walletAddress || req.session?.walletAddress;
  if (!walletAddress) return null;
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE wallet_address = $1 LIMIT 1",
    [walletAddress],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Read-only v1 logical-agent fleet overview.  The two CTE aggregate scans
 * avoid per-agent proof queries; NULL certification.agent_id is kept separate
 * as historical rather than being attributed to the account default.
 */
export function registerFleetOverviewRoutes(app: Express) {
  app.get("/api/fleet/overview", isWalletAuthenticated, async (req: any, res) => {
    try {
      const ownerAccountId = await sessionAccountId(req);
      if (!ownerAccountId) {
        return res.status(401).json({ error: "UNAUTHORIZED", message: "No account for this session wallet" });
      }

      const result = await pool.query<any>(`
        WITH effective_agents AS (
          SELECT id, name, owner_account_id, created_at, last_seen_at
          FROM agents
          WHERE owner_account_id = $1
          UNION ALL
          SELECT u.id,
            COALESCE(NULLIF(BTRIM(u.agent_name), ''), NULLIF(BTRIM(u.company_name), ''), 'Default agent'),
            u.id, u.created_at, NULL::timestamp
          FROM users u
          WHERE u.id = $1
            AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = u.id)
        ),
        agent_proofs AS (
          SELECT c.agent_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c.blockchain_status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE c.blockchain_status = 'confirmed')::int AS confirmed,
            COUNT(*) FILTER (WHERE c.blockchain_status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE c.blockchain_status = 'failed'
              AND c.created_at >= NOW() - INTERVAL '24 hours')::int AS failed_24h,
            COUNT(*) FILTER (WHERE c.blockchain_status = 'pending'
              AND c.created_at < NOW() - INTERVAL '15 minutes')::int AS pending_over_15m,
            MAX(c.created_at) AS last_proof_at,
            (ARRAY_AGG(c.id ORDER BY c.created_at DESC))[1] AS last_proof_id,
            (ARRAY_AGG(c.blockchain_status ORDER BY c.created_at DESC))[1] AS last_proof_status
          FROM certifications c
          INNER JOIN effective_agents effective_agent
            ON effective_agent.id = c.agent_id
            AND c.user_id = effective_agent.owner_account_id
          GROUP BY c.agent_id
        ),
        historical AS (
          SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE blockchain_status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE blockchain_status = 'confirmed')::int AS confirmed,
            COUNT(*) FILTER (WHERE blockchain_status = 'failed')::int AS failed,
            MAX(created_at) AS last_proof_at,
            (ARRAY_AGG(id ORDER BY created_at DESC))[1] AS last_proof_id,
            (ARRAY_AGG(blockchain_status ORDER BY created_at DESC))[1] AS last_proof_status
          FROM certifications
          WHERE user_id = $1 AND agent_id IS NULL
        )
        SELECT a.id, a.name, a.owner_account_id, a.created_at, a.last_seen_at,
          COALESCE(p.total, 0) AS total, COALESCE(p.pending, 0) AS pending,
          COALESCE(p.confirmed, 0) AS confirmed, COALESCE(p.failed, 0) AS failed,
          COALESCE(p.failed_24h, 0) AS failed_24h,
          COALESCE(p.pending_over_15m, 0) AS pending_over_15m, p.last_proof_at,
          p.last_proof_id, p.last_proof_status,
          h.total AS historical_total, h.pending AS historical_pending,
          h.confirmed AS historical_confirmed, h.failed AS historical_failed,
          h.last_proof_at AS historical_last_proof_at,
          h.last_proof_id AS historical_last_proof_id,
          h.last_proof_status AS historical_last_proof_status
        FROM effective_agents a
        LEFT JOIN agent_proofs p ON p.agent_id = a.id
        CROSS JOIN historical h
        WHERE a.owner_account_id = $1
        ORDER BY a.created_at ASC, a.id ASC
      `, [ownerAccountId]);

      const historical = result.rows[0];
      const agents: any[] = result.rows.map((row: any) => {
        const { health, reasons } = fleetHealth(
          row.last_seen_at,
          Number(row.failed_24h),
          Number(row.pending_over_15m),
        );
        return {
          agent_id: row.id,
          name: row.name,
          owner_account_id: row.owner_account_id,
          created_at: iso(row.created_at),
          last_seen_at: iso(row.last_seen_at),
          health,
          reasons,
          proof_totals: { total: Number(row.total), pending: Number(row.pending), confirmed: Number(row.confirmed), failed: Number(row.failed) },
          status_counts: { pending: Number(row.pending), confirmed: Number(row.confirmed), failed: Number(row.failed) },
          last_proof_at: iso(row.last_proof_at),
          last_proof: row.last_proof_id ? { proof_id: row.last_proof_id, status: row.last_proof_status, created_at: iso(row.last_proof_at) } : null,
        };
      });
      const historicalTotal = Number(historical?.historical_total ?? 0);
      if (historicalTotal > 0) {
        agents.push({
          agent_id: null,
          name: HISTORICAL_LABEL,
          owner_account_id: ownerAccountId,
          created_at: null,
          last_seen_at: null,
          health: null,
          reasons: ["historical_unattributed"],
          proof_totals: { total: historicalTotal, pending: Number(historical.historical_pending), confirmed: Number(historical.historical_confirmed), failed: Number(historical.historical_failed) },
          status_counts: { pending: Number(historical.historical_pending), confirmed: Number(historical.historical_confirmed), failed: Number(historical.historical_failed) },
          last_proof_at: iso(historical.historical_last_proof_at),
          last_proof: {
            proof_id: historical.historical_last_proof_id,
            status: historical.historical_last_proof_status,
            created_at: iso(historical.historical_last_proof_at),
          },
        });
      }
      const realAgents = agents.filter((agent) => agent.agent_id !== null);
      return res.json({
        generated_at: new Date().toISOString(),
        health_rules: {
          red: "Any failed proof exists in the trailing 24 hours.",
          orange: "No last_seen_at, last_seen_at older than 24 hours, or a pending proof older than 15 minutes.",
          green: "Otherwise.",
          precedence: ["red", "orange", "green"],
        },
        summary: {
          total_agents: realAgents.length,
          green: realAgents.filter((agent) => agent.health === "green").length,
          orange: realAgents.filter((agent) => agent.health === "orange").length,
          red: realAgents.filter((agent) => agent.health === "red").length,
          historical_unattributed_proofs: historicalTotal,
        },
        agents,
      });
    } catch (error) {
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to load fleet overview" });
    }
  });
}