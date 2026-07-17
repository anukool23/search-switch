import type {
  Aggregation,
  Bucket,
  DateInterval,
} from "../types.js";
import type { FieldResolver } from "./query.js";

/** Generic interval → OpenSearch calendar_interval token. */
const CALENDAR_INTERVAL: Record<DateInterval, string> = {
  minute: "minute",
  hour: "hour",
  day: "day",
  week: "week",
  month: "month",
};

const DEFAULT_TERMS_SIZE = 10;

export function buildAggregations(
  aggregations: Record<string, Aggregation>,
  resolve: FieldResolver,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  for (const [name, agg] of Object.entries(aggregations)) {
    switch (agg.kind) {
      case "dateHistogram":
        body[name] = {
          date_histogram: {
            field: resolve(agg.field, false),
            calendar_interval: CALENDAR_INTERVAL[agg.interval],
          },
        };
        break;

      case "terms":
        body[name] = {
          terms: {
            field: resolve(agg.field, true),
            size: agg.size ?? DEFAULT_TERMS_SIZE,
          },
        };
        break;

      case "cardinality":
        body[name] = { cardinality: { field: resolve(agg.field, true) } };
        break;
    }
  }

  return body;
}

interface ParsedAggregations {
  buckets: Record<string, Bucket[]>;
  values: Record<string, number>;
}

/**
 * Flattens OpenSearch's aggregation response into the generic shape.
 *
 * Bucketing aggs (dateHistogram/terms) produce a list; cardinality produces a
 * single number. They land in `buckets` and `values` respectively so callers
 * don't have to type-narrow on every read.
 */
export function parseAggregations(
  raw: unknown,
  requested: Record<string, Aggregation>,
): ParsedAggregations {
  const buckets: Record<string, Bucket[]> = {};
  const values: Record<string, number> = {};

  if (typeof raw !== "object" || raw === null) {
    return { buckets, values };
  }

  const container = raw as Record<string, unknown>;

  for (const [name, agg] of Object.entries(requested)) {
    const result = container[name];
    if (typeof result !== "object" || result === null) continue;

    if (agg.kind === "cardinality") {
      const value = (result as { value?: unknown }).value;
      values[name] = typeof value === "number" ? value : 0;
      continue;
    }

    const rawBuckets = (result as { buckets?: unknown }).buckets;
    if (!Array.isArray(rawBuckets)) {
      buckets[name] = [];
      continue;
    }

    buckets[name] = rawBuckets.map((b): Bucket => {
      const entry = b as { key?: unknown; key_as_string?: unknown; doc_count?: unknown };
      // date_histogram returns key as epoch millis plus a formatted
      // key_as_string; prefer the readable one when present.
      const key =
        typeof entry.key_as_string === "string"
          ? entry.key_as_string
          : String(entry.key ?? "");
      return { key, count: typeof entry.doc_count === "number" ? entry.doc_count : 0 };
    });
  }

  return { buckets, values };
}
