import { ValidationError } from "../errors.js";
import type { Filter, FilterValue, SearchQuery, Sort } from "../types.js";

/**
 * Resolves a logical field name to the name OpenSearch needs.
 *
 * `exact: true` means "I need to match/sort/bucket on the whole value", which
 * for analyzed text requires the `.keyword` sub-field. Callers of this library
 * never learn that; the store supplies a resolver built from the index schema.
 */
export type FieldResolver = (field: string, exact: boolean) => string;

/** Identity resolver — for tests and for indices with no known schema. */
export const passthroughResolver: FieldResolver = (field) => field;

function normalize(value: FilterValue): string | number | boolean {
  return value instanceof Date ? value.toISOString() : value;
}

function requireScalar(filter: Filter, value: FilterValue | FilterValue[]): FilterValue {
  if (Array.isArray(value)) {
    throw new ValidationError(
      `filter on "${filter.field}" with op "${filter.op}" requires a single value, got an array`,
    );
  }
  return value;
}

export function buildFilterClause(
  filter: Filter,
  resolve: FieldResolver,
): Record<string, unknown> {
  const { field, op, value } = filter;

  if (op === "exists") {
    return { exists: { field: resolve(field, false) } };
  }

  if (value === undefined) {
    throw new ValidationError(
      `filter on "${field}" with op "${op}" requires a value`,
    );
  }

  switch (op) {
    case "eq":
      return { term: { [resolve(field, true)]: normalize(requireScalar(filter, value)) } };

    case "neq":
      return {
        bool: {
          must_not: [
            { term: { [resolve(field, true)]: normalize(requireScalar(filter, value)) } },
          ],
        },
      };

    case "in": {
      if (!Array.isArray(value)) {
        throw new ValidationError(
          `filter on "${field}" with op "in" requires an array value`,
        );
      }
      return { terms: { [resolve(field, true)]: value.map(normalize) } };
    }

    case "gt":
    case "gte":
    case "lt":
    case "lte":
      // Range ops target the raw field: numbers and dates are never analyzed,
      // so there is no keyword twin to resolve to.
      return {
        range: {
          [resolve(field, false)]: { [op]: normalize(requireScalar(filter, value)) },
        },
      };
  }
}

/** Builds the `query` portion of an OpenSearch request body. */
export function buildQuery(
  query: SearchQuery,
  resolve: FieldResolver,
): Record<string, unknown> {
  const filterClauses = (query.filters ?? []).map((f) => buildFilterClause(f, resolve));

  const mustClauses: Record<string, unknown>[] = [];
  if (query.text !== undefined) {
    if (query.text.fields.length === 0) {
      throw new ValidationError("text query requires at least one field");
    }
    mustClauses.push({
      multi_match: { query: query.text.value, fields: query.text.fields },
    });
  }

  if (mustClauses.length === 0 && filterClauses.length === 0) {
    return { match_all: {} };
  }

  const bool: Record<string, unknown> = {};
  if (mustClauses.length > 0) bool["must"] = mustClauses;
  // `filter` context, not `must` — filters don't contribute to relevance scoring
  // and are cacheable by the engine.
  if (filterClauses.length > 0) bool["filter"] = filterClauses;

  return { bool };
}

export function buildSort(
  sorts: Sort[] | undefined,
  resolve: FieldResolver,
): Record<string, unknown>[] | undefined {
  if (sorts === undefined || sorts.length === 0) return undefined;
  return sorts.map((s) => ({ [resolve(s.field, true)]: { order: s.direction } }));
}
