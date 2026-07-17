import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, IndexNotFoundError } from "../errors.js";
import type { OpenSearchClientLike } from "../opensearch/client.js";
import { OpenSearchStore } from "../opensearch/store.js";

/** Shapes an OpenSearch client error closely enough to exercise our translation. */
function osError(statusCode: number, type?: string): Error & Record<string, unknown> {
  const err = new Error(type ?? `status ${statusCode}`) as Error & Record<string, unknown>;
  err["statusCode"] = statusCode;
  if (type !== undefined) err["body"] = { error: { type } };
  return err;
}

function fakeClient(): OpenSearchClientLike {
  return {
    indices: {
      create: vi.fn().mockResolvedValue({ body: {} }),
      delete: vi.fn().mockResolvedValue({ body: {} }),
      exists: vi.fn().mockResolvedValue({ statusCode: 404, body: false }),
      getMapping: vi.fn().mockResolvedValue({ body: {} }),
    },
    index: vi.fn().mockResolvedValue({ body: {} }),
    get: vi.fn().mockResolvedValue({ body: { _source: {} } }),
    delete: vi.fn().mockResolvedValue({ body: {} }),
    bulk: vi.fn().mockResolvedValue({ body: { items: [] } }),
    search: vi.fn().mockResolvedValue({ body: { hits: { total: { value: 0 }, hits: [] } } }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("OpenSearchStore index naming", () => {
  it("applies the configured prefix to index names", async () => {
    const client = fakeClient();
    const store = new OpenSearchStore(client, "lumea-prod-");

    await store.index("views", "1", { postId: "p1" });

    expect(client.index).toHaveBeenCalledWith(
      expect.objectContaining({ index: "lumea-prod-views", id: "1" }),
    );
  });

  it("uses the bare name when no prefix is configured", async () => {
    const client = fakeClient();
    const store = new OpenSearchStore(client);

    await store.index("views", "1", { postId: "p1" });

    expect(client.index).toHaveBeenCalledWith(expect.objectContaining({ index: "views" }));
  });
});

describe("OpenSearchStore.createIndex", () => {
  let client: OpenSearchClientLike;
  let store: OpenSearchStore;

  beforeEach(() => {
    client = fakeClient();
    store = new OpenSearchStore(client);
  });

  it("creates the index with translated mappings when absent", async () => {
    await store.createIndex({
      name: "views",
      fields: { postId: { type: "keyword" }, timestamp: { type: "date" } },
    });

    expect(client.indices.create).toHaveBeenCalledWith({
      index: "views",
      body: {
        mappings: { properties: { postId: { type: "keyword" }, timestamp: { type: "date" } } },
      },
    });
  });

  it("is idempotent — does not recreate an existing index", async () => {
    vi.mocked(client.indices.exists).mockResolvedValue({ statusCode: 200, body: true });

    await store.createIndex({ name: "views", fields: { postId: { type: "keyword" } } });

    expect(client.indices.create).not.toHaveBeenCalled();
  });

  it("tolerates losing a create race against a concurrent boot", async () => {
    vi.mocked(client.indices.create).mockRejectedValue(
      osError(400, "resource_already_exists_exception"),
    );

    await expect(
      store.createIndex({ name: "views", fields: { postId: { type: "keyword" } } }),
    ).resolves.toBeUndefined();
  });

  it("registers the schema so later queries resolve fields without a mapping fetch", async () => {
    await store.createIndex({ name: "posts", fields: { tags: { type: "text", exactMatch: true } } });

    await store.search("posts", { filters: [{ field: "tags", op: "eq", value: "go" }] });

    expect(client.indices.getMapping).not.toHaveBeenCalled();
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          query: { bool: { filter: [{ term: { "tags.keyword": "go" } }] } },
        }),
      }),
    );
  });
});

describe("OpenSearchStore.search", () => {
  it("maps hits into the generic result shape", async () => {
    const client = fakeClient();
    vi.mocked(client.search).mockResolvedValue({
      body: {
        hits: {
          total: { value: 2 },
          hits: [
            { _id: "a", _score: 1.5, _source: { title: "One" } },
            { _id: "b", _score: null, _source: { title: "Two" } },
          ],
        },
      },
    });

    const store = new OpenSearchStore(client);
    await expect(store.search("posts", {})).resolves.toEqual({
      total: 2,
      hits: [
        { id: "a", score: 1.5, document: { title: "One" } },
        { id: "b", score: null, document: { title: "Two" } },
      ],
    });
  });

  it("reads a legacy bare-number total", async () => {
    const client = fakeClient();
    vi.mocked(client.search).mockResolvedValue({ body: { hits: { total: 7, hits: [] } } });

    const store = new OpenSearchStore(client);
    await expect(store.search("posts", {})).resolves.toMatchObject({ total: 7 });
  });

  it("applies limit and offset, and tracks true totals", async () => {
    const client = fakeClient();
    const store = new OpenSearchStore(client);

    await store.search("posts", { limit: 5, offset: 10 });

    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ size: 5, from: 10, track_total_hits: true }),
      }),
    );
  });

  it("defaults to a page size of 20", async () => {
    const client = fakeClient();
    const store = new OpenSearchStore(client);

    await store.search("posts", {});

    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ size: 20, from: 0 }) }),
    );
  });

  it("recovers an unregistered schema from the cluster mapping", async () => {
    const client = fakeClient();
    vi.mocked(client.indices.getMapping).mockResolvedValue({
      body: {
        posts: {
          mappings: {
            properties: { tags: { type: "text", fields: { keyword: { type: "keyword" } } } },
          },
        },
      },
    });

    const store = new OpenSearchStore(client);
    await store.search("posts", { filters: [{ field: "tags", op: "eq", value: "go" }] });

    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          query: { bool: { filter: [{ term: { "tags.keyword": "go" } }] } },
        }),
      }),
    );
  });
});

describe("OpenSearchStore.aggregate", () => {
  it("requests zero documents and returns the flattened result", async () => {
    const client = fakeClient();
    vi.mocked(client.search).mockResolvedValue({
      body: {
        hits: { total: { value: 20 } },
        aggregations: { unique: { value: 4 } },
      },
    });

    const store = new OpenSearchStore(client);
    const result = await store.aggregate("views", {
      filters: [{ field: "postId", op: "eq", value: "p1" }],
      aggregations: { unique: { kind: "cardinality", field: "sessionId" } },
    });

    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          size: 0,
          query: { bool: { filter: [{ term: { postId: "p1" } }] } },
          aggs: { unique: { cardinality: { field: "sessionId" } } },
        }),
      }),
    );
    expect(result).toEqual({ total: 20, buckets: {}, values: { unique: 4 } });
  });
});

describe("OpenSearchStore.bulkIndex", () => {
  it("short-circuits on an empty batch without calling the client", async () => {
    const client = fakeClient();
    const store = new OpenSearchStore(client);

    await expect(store.bulkIndex("views", [])).resolves.toEqual({
      indexed: 0,
      failed: 0,
      errors: [],
    });
    expect(client.bulk).not.toHaveBeenCalled();
  });

  it("interleaves action and document lines", async () => {
    const client = fakeClient();
    const store = new OpenSearchStore(client, "p-");

    await store.bulkIndex("views", [{ id: "1", document: { postId: "a" } }]);

    expect(client.bulk).toHaveBeenCalledWith(
      expect.objectContaining({
        body: [{ index: { _index: "p-views", _id: "1" } }, { postId: "a" }],
      }),
    );
  });

  it("reports partial failure instead of throwing", async () => {
    const client = fakeClient();
    vi.mocked(client.bulk).mockResolvedValue({
      body: {
        errors: true,
        items: [
          { index: {} },
          { index: { error: { reason: "mapper_parsing_exception" } } },
        ],
      },
    });

    const store = new OpenSearchStore(client);
    await expect(
      store.bulkIndex("views", [
        { id: "1", document: {} },
        { id: "2", document: {} },
      ]),
    ).resolves.toEqual({ indexed: 1, failed: 1, errors: ["mapper_parsing_exception"] });
  });
});

describe("OpenSearchStore absence handling", () => {
  it("returns null rather than throwing when a document is missing", async () => {
    const client = fakeClient();
    vi.mocked(client.get).mockRejectedValue(osError(404));

    const store = new OpenSearchStore(client);
    await expect(store.get("views", "nope")).resolves.toBeNull();
  });

  it("treats deleting an absent document as a no-op", async () => {
    const client = fakeClient();
    vi.mocked(client.delete).mockRejectedValue(osError(404));

    const store = new OpenSearchStore(client);
    await expect(store.delete("views", "nope")).resolves.toBeUndefined();
  });

  it("treats deleting an absent index as a no-op", async () => {
    const client = fakeClient();
    vi.mocked(client.indices.delete).mockRejectedValue(osError(404));

    const store = new OpenSearchStore(client);
    await expect(store.deleteIndex("nope")).resolves.toBeUndefined();
  });
});

describe("OpenSearchStore error translation", () => {
  it("raises IndexNotFoundError for a missing index", async () => {
    const client = fakeClient();
    vi.mocked(client.search).mockRejectedValue(osError(404, "index_not_found_exception"));

    const store = new OpenSearchStore(client);
    await expect(store.search("gone", {})).rejects.toBeInstanceOf(IndexNotFoundError);
  });

  it("raises ConnectionError when the cluster is unreachable", async () => {
    const client = fakeClient();
    const err = new Error("connect ECONNREFUSED") as Error & Record<string, unknown>;
    err["code"] = "ECONNREFUSED";
    vi.mocked(client.index).mockRejectedValue(err);

    const store = new OpenSearchStore(client);
    await expect(store.index("views", "1", {})).rejects.toBeInstanceOf(ConnectionError);
  });
});
