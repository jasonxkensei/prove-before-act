/**
 * Produce a 3.0 document from the same canonical 3.1 document served by ACP.
 * OpenAPI 3.0 has no standard top-level `webhooks` field and uses `nullable`
 * instead of JSON Schema null type unions. Keep the legacy x-webhooks
 * extension for tools that explicitly support it.
 */
export function toOpenApi30(canonical: Record<string, unknown>): Record<string, unknown> {
  if (canonical.openapi !== "3.1.0") {
    throw new Error("Expected a canonical OpenAPI 3.1 document");
  }
  const compatible = structuredClone(canonical);
  compatible.openapi = "3.0.3";
  delete compatible.webhooks;

  function convert(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(convert);
      return;
    }
    if (!node || typeof node !== "object") return;
    const schema = node as Record<string, unknown>;
    if (Array.isArray(schema.type)) {
      const types = schema.type;
      const nonNullTypes = types.filter(type => type !== "null");
      if (types.length !== 2 || nonNullTypes.length !== 1 ||
          typeof nonNullTypes[0] !== "string" || !types.includes("null")) {
        throw new Error("Unsupported OpenAPI 3.1 type union in 3.0 compatibility document");
      }
      schema.type = nonNullTypes[0];
      schema.nullable = true;
      // Retain null in enum where present: nullable changes the type, while
      // an enum still restricts the set of values accepted by older tools.
    }
    Object.values(schema).forEach(convert);
  }
  convert(compatible);
  return compatible;
}