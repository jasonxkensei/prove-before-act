import { and, eq } from "drizzle-orm";
import { agents, users, type ApiKey } from "@shared/schema";
import { db } from "./db";

type DatabaseExecutor = typeof db | any;

export function defaultAgentName(account: Pick<typeof users.$inferSelect, "agentName" | "companyName">): string {
  return account.agentName?.trim() || account.companyName?.trim() || "Default agent";
}

/**
 * Returns the account's deterministic default logical agent.  The caller may
 * supply a transaction executor so account/key creation stays atomic.
 */
export async function ensureDefaultAgent(
  ownerAccountId: string,
  name: string | undefined = undefined,
  database: DatabaseExecutor = db,
) {
  let resolvedName = name?.trim();
  if (!resolvedName) {
    const [account] = await database.select({
      agentName: users.agentName,
      companyName: users.companyName,
    })
      .from(users)
      .where(eq(users.id, ownerAccountId))
      .limit(1);
    if (!account) {
      throw new Error("Account could not be found while creating its default agent");
    }
    resolvedName = defaultAgentName(account);
  }
  const [created] = await database.insert(agents)
    .values({ id: ownerAccountId, ownerAccountId, name: resolvedName })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [existing] = await database.select()
    .from(agents)
    .where(eq(agents.id, ownerAccountId))
    .limit(1);
  if (!existing) {
    throw new Error("Default agent could not be resolved after creation");
  }
  return existing;
}

/**
 * Resolves an API key to its explicit logical agent, falling back only to the
 * deterministic account default when agent_id is NULL.  An invalid
 * cross-account reference is not trusted and also resolves to that default.
 */
export async function resolveAgentForApiKey(
  apiKey: Pick<ApiKey, "agentId" | "userId">,
  database: DatabaseExecutor = db,
) {
  if (apiKey.agentId) {
    const [explicitAgent] = await database.select()
      .from(agents)
      .where(and(eq(agents.id, apiKey.agentId), eq(agents.ownerAccountId, apiKey.userId)))
      .limit(1);
    if (explicitAgent) return explicitAgent;
  }
  return ensureDefaultAgent(apiKey.userId, undefined, database);
}