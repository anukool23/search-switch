import { describe, expect, it } from "vitest";
import {
  fromMappingProperties,
  toMappingProperties,
} from "../opensearch/mapping.js";
import type { FieldDef } from "../types.js";

describe("toMappingProperties", () => {
  it("maps generic types to OpenSearch native types", () => {
    expect(
      toMappingProperties({
        title: { type: "text" },
        postId: { type: "keyword" },
        views: { type: "integer" },
        score: { type: "float" },
        premium: { type: "boolean" },
        ts: { type: "date" },
      }),
    ).toEqual({
      title: { type: "text" },
      postId: { type: "keyword" },
      views: { type: "long" },
      score: { type: "double" },
      premium: { type: "boolean" },
      ts: { type: "date" },
    });
  });

  it("adds a keyword sub-field to text fields that need exact match", () => {
    expect(toMappingProperties({ tags: { type: "text", exactMatch: true } })).toEqual({
      tags: {
        type: "text",
        fields: { keyword: { type: "keyword", ignore_above: 256 } },
      },
    });
  });

  it("ignores exactMatch on types that are never analyzed", () => {
    expect(toMappingProperties({ postId: { type: "keyword", exactMatch: true } })).toEqual({
      postId: { type: "keyword" },
    });
  });
});

describe("fromMappingProperties", () => {
  it("round-trips a schema through the mapping form", () => {
    const original: Record<string, FieldDef> = {
      title: { type: "text" },
      tags: { type: "text", exactMatch: true },
      postId: { type: "keyword" },
      views: { type: "integer" },
      ts: { type: "date" },
    };

    expect(fromMappingProperties(toMappingProperties(original))).toEqual(original);
  });

  it("normalises native numeric variants to generic types", () => {
    expect(
      fromMappingProperties({
        a: { type: "integer" },
        b: { type: "short" },
        c: { type: "scaled_float" },
      }),
    ).toEqual({
      a: { type: "integer" },
      b: { type: "integer" },
      c: { type: "float" },
    });
  });

  it("skips fields with unknown or missing types", () => {
    expect(
      fromMappingProperties({
        good: { type: "keyword" },
        weird: { type: "geo_point" },
        empty: {},
        nope: null,
      }),
    ).toEqual({ good: { type: "keyword" } });
  });
});
