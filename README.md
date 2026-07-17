# search-switch

Backend-agnostic search & analytics data layer for TypeScript.

One generic API over OpenSearch today — Elasticsearch, Meilisearch, and others later. **Switching backends is a config change, not a rewrite.**

```bash
npm install search-switch @opensearch-project/opensearch
```

Backend clients are *optional peer dependencies*: you install only the driver you actually use.

## Quick start

```ts
import { createSearchStore } from "search-switch";

const store = await createSearchStore({
  driver: "opensearch",          // the only line that changes when you switch backends
  node: process.env.SEARCH_NODE!,
  auth: { kind: "awsSigV4", region: "us-east-1", service: "es" },
  indexPrefix: "lumea-prod-",
});

await store.createIndex({
  name: "views",
  fields: {
    postId: { type: "keyword" },
    sessionId: { type: "keyword" },
    referrer: { type: "text", exactMatch: true },
    timestamp: { type: "date" },
  },
});

await store.index("views", crypto.randomUUID(), {
  postId: "p1",
  sessionId: "s1",
  referrer: "https://google.com",
  timestamp: new Date().toISOString(),
});
```

## The design rule

Nothing in the public API leaks a backend's query language. You never write
`{ bool: { must: [...] } }`. You describe **intent**; the driver translates it.

```ts
// Intent: "published posts matching 'hono', newest first"
await store.search("posts", {
  text: { fields: ["title", "content"], value: "hono" },
  filters: [{ field: "status", op: "eq", value: "PUBLISHED" }],
  sort: [{ field: "publishedAt", direction: "desc" }],
  limit: 20,
});
```

If you ever have to hand-write engine DSL to get something done, the abstraction
has failed — open an issue rather than reaching around it.

## Aggregations

```ts
const stats = await store.aggregate("views", {
  filters: [{ field: "postId", op: "eq", value: "p1" }],
  aggregations: {
    overTime: { kind: "dateHistogram", field: "timestamp", interval: "day" },
    topReferrers: { kind: "terms", field: "referrer", size: 5 },
    uniqueVisitors: { kind: "cardinality", field: "sessionId" },
  },
});

stats.total;                    // documents matched by filters
stats.buckets.overTime;         // [{ key: "2026-07-01T00:00:00.000Z", count: 12 }, ...]
stats.buckets.topReferrers;     // [{ key: "https://google.com", count: 5 }, ...]
stats.values.uniqueVisitors;    // 17
```

Bucketing aggregations land in `buckets`, single-value ones in `values`, so you
never type-narrow on a read.

## `exactMatch`, and why you don't say `.keyword`

Analyzed text can be full-text searched but not reliably filtered, sorted, or
bucketed — OpenSearch needs a `.keyword` sub-field for that. Other engines model
this differently or not at all, so `search-switch` takes a declaration of intent:

```ts
fields: { referrer: { type: "text", exactMatch: true } }
```

You then just say `field: "referrer"` everywhere. The driver resolves it to
`referrer.keyword` for terms/sorts/exact filters, and leaves it alone for
full-text and ranges. Schemas registered via `createIndex` are cached; for an
index you didn't create in this process, the mapping is recovered from the
cluster on first use.

## API

| Method | Notes |
|---|---|
| `createIndex(schema)` | Idempotent — safe on every boot; tolerates concurrent cold starts |
| `deleteIndex(name)` | Absent index is a no-op |
| `indexExists(name)` | |
| `index(indexName, id, doc)` | Insert or replace |
| `bulkIndex(indexName, docs)` | Partial failure is **reported**, not thrown |
| `get<T>(indexName, id)` | `null` when absent — absence isn't exceptional |
| `search<T>(indexName, query)` | Defaults to 20 hits; totals are exact |
| `aggregate(indexName, request)` | Returns no documents |
| `delete(indexName, id)` | Absent document is a no-op |
| `close()` | |

Index names are **logical** — `indexPrefix` is applied by the driver, so you say
`"views"` and get `"lumea-prod-views"`.

## Errors

Branch on type, never on message text:

```ts
import { IndexNotFoundError, ConnectionError } from "search-switch";

try {
  await store.search("views", {});
} catch (e) {
  if (e instanceof IndexNotFoundError) { /* ... */ }
  if (e instanceof ConnectionError)    { /* retry */ }
}
```

`SearchError` (base) · `IndexNotFoundError` · `DocumentNotFoundError` ·
`ConnectionError` · `DriverNotInstalledError` · `ValidationError`

## Auth

```ts
auth: { kind: "basic", username, password }
auth: { kind: "apiKey", apiKey }
auth: { kind: "awsSigV4", region: "us-east-1", service: "es" }  // or "aoss" for Serverless
```

SigV4 additionally needs `@aws-sdk/credential-provider-node` installed; it's
loaded lazily, so basic-auth users never pay for it.

## Roadmap

- **v0.1** — OpenSearch
- next — Elasticsearch, Meilisearch

Adding a driver means implementing the `SearchStore` interface and adding one
member to the `SearchDriver` union. No consumer code changes.

## License

MIT
