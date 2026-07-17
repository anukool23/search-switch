import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import {
  buildFilterClause,
  buildQuery,
  buildSort,
  passthroughResolver,
  type FieldResolver,
} from "../opensearch/query.js";

/** Pretends `tags` is analyzed text with a keyword twin. */
const tagsResolver: FieldResolver = (field, exact) =>
  exact && field === "tags" ? "tags.keyword" : field;

describe("buildFilterClause", () => {
  it("builds a term clause for eq", () => {
    expect(
      buildFilterClause({ field: "postId", op: "eq", value: "abc" }, passthroughResolver),
    ).toEqual({ term: { postId: "abc" } });
  });

  it("builds a negated term clause for neq", () => {
    expect(
      buildFilterClause({ field: "status", op: "neq", value: "DRAFT" }, passthroughResolver),
    ).toEqual({ bool: { must_not: [{ term: { status: "DRAFT" } }] } });
  });

  it("builds a terms clause for in", () => {
    expect(
      buildFilterClause({ field: "status", op: "in", value: ["A", "B"] }, passthroughResolver),
    ).toEqual({ terms: { status: ["A", "B"] } });
  });

  it.each(["gt", "gte", "lt", "lte"] as const)("builds a range clause for %s", (op) => {
    expect(buildFilterClause({ field: "views", op, value: 10 }, passthroughResolver)).toEqual({
      range: { views: { [op]: 10 } },
    });
  });

  it("builds an exists clause without a value", () => {
    expect(
      buildFilterClause({ field: "referrer", op: "exists" }, passthroughResolver),
    ).toEqual({ exists: { field: "referrer" } });
  });

  it("serialises Date values to ISO strings", () => {
    const date = new Date("2026-07-01T10:00:00.000Z");
    expect(
      buildFilterClause({ field: "ts", op: "gte", value: date }, passthroughResolver),
    ).toEqual({ range: { ts: { gte: "2026-07-01T10:00:00.000Z" } } });
  });

  it("resolves exact-match ops to the keyword sub-field", () => {
    expect(buildFilterClause({ field: "tags", op: "eq", value: "go" }, tagsResolver)).toEqual({
      term: { "tags.keyword": "go" },
    });
  });

  it("leaves range ops on the raw field — numbers and dates are never analyzed", () => {
    expect(buildFilterClause({ field: "tags", op: "gt", value: 1 }, tagsResolver)).toEqual({
      range: { tags: { gt: 1 } },
    });
  });

  it("rejects a missing value", () => {
    expect(() =>
      buildFilterClause({ field: "postId", op: "eq" }, passthroughResolver),
    ).toThrow(ValidationError);
  });

  it("rejects an array value for a scalar op", () => {
    expect(() =>
      buildFilterClause({ field: "views", op: "gt", value: [1, 2] }, passthroughResolver),
    ).toThrow(ValidationError);
  });

  it("rejects a scalar value for in", () => {
    expect(() =>
      buildFilterClause({ field: "status", op: "in", value: "A" }, passthroughResolver),
    ).toThrow(ValidationError);
  });
});

describe("buildQuery", () => {
  it("returns match_all for an empty query", () => {
    expect(buildQuery({}, passthroughResolver)).toEqual({ match_all: {} });
  });

  it("puts filters in filter context, not must", () => {
    expect(
      buildQuery({ filters: [{ field: "status", op: "eq", value: "PUBLISHED" }] }, passthroughResolver),
    ).toEqual({ bool: { filter: [{ term: { status: "PUBLISHED" } }] } });
  });

  it("builds a multi_match for text queries", () => {
    expect(
      buildQuery({ text: { fields: ["title", "content"], value: "hono" } }, passthroughResolver),
    ).toEqual({
      bool: { must: [{ multi_match: { query: "hono", fields: ["title", "content"] } }] },
    });
  });

  it("combines text and filters", () => {
    expect(
      buildQuery(
        {
          text: { fields: ["title"], value: "go" },
          filters: [{ field: "status", op: "eq", value: "PUBLISHED" }],
        },
        passthroughResolver,
      ),
    ).toEqual({
      bool: {
        must: [{ multi_match: { query: "go", fields: ["title"] } }],
        filter: [{ term: { status: "PUBLISHED" } }],
      },
    });
  });

  it("rejects a text query with no fields", () => {
    expect(() => buildQuery({ text: { fields: [], value: "x" } }, passthroughResolver)).toThrow(
      ValidationError,
    );
  });
});

describe("buildSort", () => {
  it("returns undefined when there is nothing to sort by", () => {
    expect(buildSort(undefined, passthroughResolver)).toBeUndefined();
    expect(buildSort([], passthroughResolver)).toBeUndefined();
  });

  it("resolves sort fields to their exact-match form", () => {
    expect(buildSort([{ field: "tags", direction: "desc" }], tagsResolver)).toEqual([
      { "tags.keyword": { order: "desc" } },
    ]);
  });
});
