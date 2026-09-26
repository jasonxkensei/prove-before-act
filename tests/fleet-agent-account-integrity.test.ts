import { describe, expect, expectTypeOf, it } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { agents, apiKeys, certifications } from "../shared/schema";

function agentOwnerForeignKey(table: typeof certifications | typeof apiKeys) {
  const foreignKey = getTableConfig(table).foreignKeys.find(
    (key) => key.getName() === `${getTableConfig(table).name}_agent_owner_fk`,
  );

  expect(foreignKey).toBeDefined();
  return foreignKey!;
}

function generatedExpression(table: typeof agents | typeof certifications | typeof apiKeys, columnName: string) {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === columnName)!;
  const generated = column.generated;

  expect(generated?.type).toBe("always");
  expect(generated?.mode).toBe("stored");
  return new PgDialect().sqlToQuery(generated!.as as any).sql;
}

describe("logical-agent account integrity", () => {
  it("allows historical NULL assignments but rejects cross-account agent assignments", () => {
    for (const table of [certifications, apiKeys] as const) {
      const config = getTableConfig(table);
      const agentId = config.columns.find((column) => column.name === "agent_id")!;
      const agentOwnershipKey = config.columns.find((column) => column.name === "agent_ownership_key")!;
      const userId = config.columns.find((column) => column.name === "user_id")!;
      const foreignKey = agentOwnerForeignKey(table);
      const reference = foreignKey.reference();

      // PostgreSQL's default MATCH SIMPLE permits NULL agent_id, preserving
      // historical rows, while the mandatory owner still participates whenever
      // an agent is assigned.
      expect(agentId.notNull).toBe(false);
      expect(agentOwnershipKey.notNull).toBe(false);
      expect(userId.notNull).toBe(true);
      expect(reference.columns.map((column) => column.name)).toEqual(["agent_ownership_key"]);
      expect(reference.foreignColumns.map((column) => column.name)).toEqual(["ownership_key"]);
      expect(reference.foreignTable).toBe(agents);
      // The builder normalizes an undeclared action to "no action"; ensure no
      // destructive or immediate restrictive behavior was declared.
      expect(["cascade", "set null", "restrict"]).not.toContain(foreignKey.onDelete);

      // No composite FK remains for Drizzle to reorder or perpetually replace.
      expect(config.foreignKeys.some((key) => key.reference().columns.length > 1)).toBe(false);
    }
  });

  it("uses stored generated ownership keys with collision-safe NULL semantics", () => {
    const ownershipConstraint = getTableConfig(agents).uniqueConstraints.find(
      (constraint) => constraint.getName() === "agents_ownership_key_unique",
    );

    expect(ownershipConstraint?.columns.map((column) => column.name)).toEqual(["ownership_key"]);
    expect(generatedExpression(agents, "ownership_key")).toBe(
      "char_length(id)::text || ':' || id || ':' || char_length(owner_account_id)::text || ':' || owner_account_id",
    );

    const childExpression =
      "CASE WHEN agent_id IS NULL THEN NULL ELSE char_length(agent_id)::text || ':' || agent_id || ':' || char_length(user_id)::text || ':' || user_id END";
    expect(generatedExpression(certifications, "agent_ownership_key")).toBe(childExpression);
    expect(generatedExpression(apiKeys, "agent_ownership_key")).toBe(childExpression);
  });

  it("does not allow callers to supply internal generated keys on inserts", () => {
    expectTypeOf<typeof agents.$inferInsert>().not.toHaveProperty("ownershipKey");
    expectTypeOf<typeof certifications.$inferInsert>().not.toHaveProperty("agentOwnershipKey");
    expectTypeOf<typeof apiKeys.$inferInsert>().not.toHaveProperty("agentOwnershipKey");
  });
});