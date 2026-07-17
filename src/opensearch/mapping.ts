import type { FieldDef, FieldType } from "../types.js";

/**
 * Generic FieldType → OpenSearch native type.
 *
 * Consumers never name a native type; this table is the only place the mapping
 * exists. A Meilisearch driver would have a completely different table (or none
 * — it infers types), which is precisely why FieldType stays abstract.
 */
const NATIVE_TYPE: Record<FieldType, string> = {
  text: "text",
  keyword: "keyword",
  integer: "long",
  float: "double",
  boolean: "boolean",
  date: "date",
};

/** Sub-field name OpenSearch conventionally uses for the exact-match twin of a text field. */
export const KEYWORD_SUBFIELD = "keyword";

export function toMappingProperties(
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const [name, def] of Object.entries(fields)) {
    const native = NATIVE_TYPE[def.type];

    // exactMatch only means anything for analyzed text — a keyword field is
    // already exact, and numbers/dates/booleans are never analyzed.
    if (def.type === "text" && def.exactMatch) {
      properties[name] = {
        type: native,
        fields: {
          [KEYWORD_SUBFIELD]: { type: "keyword", ignore_above: 256 },
        },
      };
    } else {
      properties[name] = { type: native };
    }
  }

  return properties;
}

/**
 * Inverse of toMappingProperties — read a live cluster mapping back into
 * generic FieldDefs.
 *
 * Needed because the store must know whether a field is analyzed text with a
 * keyword twin in order to resolve field names for filters/sorts/aggregations.
 * When a caller didn't register the schema via createIndex (e.g. a Lambda cold
 * start against a pre-existing index), we recover it from the cluster instead
 * of silently aggregating on an analyzed field and returning token soup.
 */
export function fromMappingProperties(
  properties: Record<string, unknown>,
): Record<string, FieldDef> {
  const fields: Record<string, FieldDef> = {};

  for (const [name, raw] of Object.entries(properties)) {
    if (typeof raw !== "object" || raw === null) continue;

    const prop = raw as { type?: unknown; fields?: unknown };
    const native = typeof prop.type === "string" ? prop.type : undefined;
    if (native === undefined) continue;

    const generic = toGenericType(native);
    if (generic === undefined) continue;

    if (generic === "text") {
      const hasKeywordTwin =
        typeof prop.fields === "object" &&
        prop.fields !== null &&
        KEYWORD_SUBFIELD in (prop.fields as Record<string, unknown>);

      fields[name] = hasKeywordTwin
        ? { type: "text", exactMatch: true }
        : { type: "text" };
    } else {
      fields[name] = { type: generic };
    }
  }

  return fields;
}

function toGenericType(native: string): FieldType | undefined {
  switch (native) {
    case "text":
      return "text";
    case "keyword":
      return "keyword";
    case "long":
    case "integer":
    case "short":
    case "byte":
      return "integer";
    case "double":
    case "float":
    case "half_float":
    case "scaled_float":
      return "float";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    default:
      return undefined;
  }
}
