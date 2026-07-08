import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../server/db";

// GET /api/admin/traffic-sources previously aggregated referrer_host visit
// counts over the *entire* history of the visits table with no time bound.
// As the table grows, a single long-running dominant referrer (e.g. a bot
// or spam source with a huge historical count) would permanently occupy the
// top of the LIMIT 100 rows and crowd out newer, currently relevant sources.
//
// The fix bounds the aggregation to a rolling window
// (TRAFFIC_SOURCES_WINDOW_DAYS, currently 30 days). This test exercises the
// underlying window logic directly against the database (mirroring the SQL
// used in server/routes/admin.ts) rather than going through the HTTP route,
// since that route requires a real wallet-backed admin session that isn't
// available in this integration test environment.

const WINDOW_DAYS = 30;

async function insertVisit(referrerHost: string, ipHash: string, daysAgo: number) {
  await pool.query(
    `INSERT INTO visits (ip_hash, is_agent, path, referrer_host, created_at)
     VALUES ($1, FALSE, '/', $2, NOW() - ($3 || ' days')::interval)`,
    [ipHash, referrerHost, String(daysAgo)],
  );
}

describe("traffic-sources rolling window", () => {
  const dominantOldReferrer = "dominant-old-referrer.test.example";
  const freshReferrer = "fresh-referrer.test.example";

  afterAll(async () => {
    await pool.query(`DELETE FROM visits WHERE referrer_host IN ($1, $2)`, [
      dominantOldReferrer,
      freshReferrer,
    ]);
  });

  it("excludes a historically dominant referrer once its visits fall outside the window, while a smaller recent referrer remains visible", async () => {
    // A referrer that generated a huge volume of visits well outside the
    // window (e.g. 90 days ago) — this simulates the "one dominant referrer"
    // starvation scenario the task describes.
    for (let i = 0; i < 50; i++) {
      await insertVisit(dominantOldReferrer, `oldrefhash${i}`, WINDOW_DAYS + 60);
    }

    // A much smaller, currently-relevant referrer with recent visits.
    for (let i = 0; i < 3; i++) {
      await insertVisit(freshReferrer, `freshrefhash${i}`, 1);
    }

    const windowed = await pool.query<{ referrer_host: string; visits: string }>(
      `SELECT referrer_host, COUNT(*) AS visits
       FROM visits
       WHERE referrer_host IS NOT NULL
         AND created_at >= NOW() - (INTERVAL '1 day' * $1)
         AND referrer_host IN ($2, $3)
       GROUP BY referrer_host
       ORDER BY visits DESC`,
      [WINDOW_DAYS, dominantOldReferrer, freshReferrer],
    );

    const hosts = windowed.rows.map((r) => r.referrer_host);
    expect(hosts).not.toContain(dominantOldReferrer);
    expect(hosts).toContain(freshReferrer);

    // Sanity check: without the window bound, the dominant old referrer
    // would still dwarf the fresh one and could starve it out of a LIMIT
    // 100 ranking under real-world data skew.
    const unbounded = await pool.query<{ referrer_host: string; visits: string }>(
      `SELECT referrer_host, COUNT(*) AS visits
       FROM visits
       WHERE referrer_host IS NOT NULL
         AND referrer_host IN ($1, $2)
       GROUP BY referrer_host
       ORDER BY visits DESC`,
      [dominantOldReferrer, freshReferrer],
    );
    const dominantRow = unbounded.rows.find((r) => r.referrer_host === dominantOldReferrer);
    const freshRow = unbounded.rows.find((r) => r.referrer_host === freshReferrer);
    expect(parseInt(dominantRow?.visits || "0")).toBeGreaterThan(parseInt(freshRow?.visits || "0"));
  });
});
