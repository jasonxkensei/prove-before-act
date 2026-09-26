import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Run the actual startup expression, not a copy of its promise chain. Loading
// index.ts itself would start the HTTP server and connect to the database.
const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

function trustStartupExpression(): string {
  let listenCallback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  function findListen(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "server" &&
      node.expression.name.text === "listen"
    ) {
      const callback = node.arguments[1];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        listenCallback = callback;
      }
    }
    ts.forEachChild(node, findListen);
  }
  findListen(file);

  if (!listenCallback || !ts.isBlock(listenCallback.body)) {
    throw new Error("Server listen callback not found");
  }
  const statements = listenCallback.body.statements.filter(
    (statement) => ts.isExpressionStatement(statement) &&
      statement.getText(file).includes("migrateTrustSnapshotSchema"),
  );
  if (statements.length !== 1 || !ts.isExpressionStatement(statements[0])) {
    throw new Error("Expected exactly one trust migration startup expression");
  }
  return statements[0].expression.getText(file);
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("trust scheduler startup migration ordering", () => {
  it("cannot begin the first leaderboard refresh before outcomes migration and cache warming finish", async () => {
    const snapshot = deferred();
    const outcomes = deferred();
    const warming = deferred();
    const outcomesStarted = deferred();
    const warmingStarted = deferred();
    const events: string[] = [];
    const migrateTrustSnapshotSchema = vi.fn(() => {
      events.push("snapshot started");
      return snapshot.promise;
    });
    const migrateAgentOutcomesTable = vi.fn(() => {
      events.push("outcomes started");
      outcomesStarted.resolve();
      return outcomes.promise;
    });
    const warmCachesFromSnapshots = vi.fn(() => {
      events.push("warming started");
      warmingStarted.resolve();
      return warming.promise;
    });
    const firstLeaderboardRefresh = vi.fn(() => events.push("leaderboard refreshed"));
    const startTrustRefreshScheduler = vi.fn(() => {
      events.push("scheduler started");
      firstLeaderboardRefresh();
    });
    const log = vi.fn();
    const Sentry = { captureException: vi.fn() };

    // The returned promise lets each phase settle without timers or a DB.
    const startup = new Function(
      "migrateTrustSnapshotSchema", "migrateAgentOutcomesTable",
      "warmCachesFromSnapshots", "startTrustRefreshScheduler", "log", "Sentry",
      `return ${trustStartupExpression()};`,
    )(
      migrateTrustSnapshotSchema, migrateAgentOutcomesTable,
      warmCachesFromSnapshots, startTrustRefreshScheduler, log, Sentry,
    ) as Promise<void>;

    expect(events).toEqual(["snapshot started"]);
    snapshot.resolve();
    await outcomesStarted.promise;
    expect(events).toEqual(["snapshot started", "outcomes started"]);
    outcomes.resolve();
    await warmingStarted.promise;
    expect(events).toEqual(["snapshot started", "outcomes started", "warming started"]);
    expect(firstLeaderboardRefresh).not.toHaveBeenCalled();
    warming.resolve();
    await startup;
    expect(events).toEqual([
      "snapshot started", "outcomes started", "warming started",
      "scheduler started", "leaderboard refreshed",
    ]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not start the scheduler if outcomes migration fails", async () => {
    const outcomes = deferred();
    const startTrustRefreshScheduler = vi.fn();
    const error = new Error("outcomes migration failed");
    const Sentry = { captureException: vi.fn() };
    const startup = new Function(
      "migrateTrustSnapshotSchema", "migrateAgentOutcomesTable",
      "warmCachesFromSnapshots", "startTrustRefreshScheduler", "log", "Sentry",
      `return ${trustStartupExpression()};`,
    )(
      () => Promise.resolve(), () => outcomes.promise,
      vi.fn(), startTrustRefreshScheduler, vi.fn(), Sentry,
    ) as Promise<void>;
    outcomes.reject(error);
    await startup;
    expect(startTrustRefreshScheduler).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(error, expect.anything());
  });
});