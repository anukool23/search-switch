import { describe, expect, it } from "vitest";
import {
  buildAggregations,
  parseAggregations,
} from "../opensearch/aggregations.js";
import { passthroughResolver, type FieldResolver } from "../opensearch/query.js";
import type { Aggregation } from "../types.js";

const referrerResolver: FieldResolver = (field, exact) =>
  exact && field === "referrer" ? "referrer.keyword" : field;

describe("buildAggregations", () => {
  it("builds a date_histogram with a calendar interval", () => {
    expect(
      buildAggregations(
        { overTime: { kind: "dateHistogram", field: "timestamp", interval: "day" } },
        passthroughResolver,
      ),
    ).toEqual({
      overTime: { date_histogram: { field: "timestamp", calendar_interval: "day" } },
    });
  });

  it("builds a terms agg with a default size", () => {
    expect(
      buildAggregations({ topTags: { kind: "terms", field: "tags" } }, passthroughResolver),
    ).toEqual({ topTags: { terms: { field: "tags", size: 10 } } });
  });

  it("honours an explicit terms size", () => {
    expect(
      buildAggregations({ topTags: { kind: "terms", field: "tags", size: 3 } }, passthroughResolver),
    ).toEqual({ topTags: { terms: { field: "tags", size: 3 } } });
  });

  it("resolves terms fields to the keyword sub-field", () => {
    expect(
      buildAggregations({ refs: { kind: "terms", field: "referrer" } }, referrerResolver),
    ).toEqual({ refs: { terms: { field: "referrer.keyword", size: 10 } } });
  });

  it("builds a cardinality agg for distinct counts", () => {
    expect(
      buildAggregations({ unique: { kind: "cardinality", field: "sessionId" } }, passthroughResolver),
    ).toEqual({ unique: { cardinality: { field: "sessionId" } } });
  });

  it("leaves date_histogram on the raw field — dates are never analyzed", () => {
    expect(
      buildAggregations(
        { t: { kind: "dateHistogram", field: "referrer", interval: "hour" } },
        referrerResolver,
      ),
    ).toEqual({ t: { date_histogram: { field: "referrer", calendar_interval: "hour" } } });
  });
});

describe("parseAggregations", () => {
  const requested: Record<string, Aggregation> = {
    overTime: { kind: "dateHistogram", field: "timestamp", interval: "day" },
    refs: { kind: "terms", field: "referrer" },
    unique: { kind: "cardinality", field: "sessionId" },
  };

  it("splits bucketing aggs from single-value aggs", () => {
    const raw = {
      overTime: {
        buckets: [
          { key: 1751328000000, key_as_string: "2026-07-01T00:00:00.000Z", doc_count: 12 },
          { key: 1751414400000, key_as_string: "2026-07-02T00:00:00.000Z", doc_count: 8 },
        ],
      },
      refs: { buckets: [{ key: "https://google.com", doc_count: 5 }] },
      unique: { value: 17 },
    };

    expect(parseAggregations(raw, requested)).toEqual({
      buckets: {
        overTime: [
          { key: "2026-07-01T00:00:00.000Z", count: 12 },
          { key: "2026-07-02T00:00:00.000Z", count: 8 },
        ],
        refs: [{ key: "https://google.com", count: 5 }],
      },
      values: { unique: 17 },
    });
  });

  it("prefers key_as_string but falls back to key", () => {
    expect(
      parseAggregations(
        { refs: { buckets: [{ key: 42, doc_count: 1 }] } },
        { refs: { kind: "terms", field: "referrer" } },
      ),
    ).toEqual({ buckets: { refs: [{ key: "42", count: 1 }] }, values: {} });
  });

  it("returns empty results for a non-object response", () => {
    expect(parseAggregations(undefined, requested)).toEqual({ buckets: {}, values: {} });
  });

  it("defaults a missing cardinality value to zero", () => {
    expect(
      parseAggregations({ unique: {} }, { unique: { kind: "cardinality", field: "s" } }),
    ).toEqual({ buckets: {}, values: { unique: 0 } });
  });

  it("yields an empty bucket list when the agg returned no buckets array", () => {
    expect(
      parseAggregations({ refs: {} }, { refs: { kind: "terms", field: "referrer" } }),
    ).toEqual({ buckets: { refs: [] }, values: {} });
  });
});
