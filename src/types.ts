/**
 * Backend-agnostic types.
 *
 * The single rule that makes this library work: NOTHING in this file may leak a
 * backend's query language. No OpenSearch/Elasticsearch DSL, no Meilisearch
 * filter strings. Every type here describes *intent* ("match this text",
 * "bucket by day"); each driver translates that intent into its own dialect.
 *
 * If a consumer ever has to write `{ bool: { must: [...] } }` to use this
 * library, the abstraction has failed and swapping backends stops being a
 * config change.
 */

/** Which backend to talk to. Adding a driver = adding a member here + an adapter. */
export type SearchDriver = "opensearch";

/** Username/password (OpenSearch default), API key, or AWS SigV4-signed requests. */
export type SearchAuth =
  | { kind: "basic"; username: string; password: string }
  | { kind: "apiKey"; apiKey: string }
  | { kind: "awsSigV4"; region: string; service: "es" | "aoss" };

export interface SearchConfig {
  driver: SearchDriver;
  /** Endpoint URL, e.g. https://search-lumea-xyz.us-east-1.es.amazonaws.com */
  node: string;
  auth?: SearchAuth;
  requestTimeoutMs?: number;
  /** Prefixed onto every index name. Lets one cluster serve dev/staging/prod. */
  indexPrefix?: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Generic field types. Each driver maps these to native types — "text" becomes
 * an analyzed field in OpenSearch, "keyword" an exact-match one. Consumers
 * never name a native type.
 */
export type FieldType =
  | "text"
  | "keyword"
  | "integer"
  | "float"
  | "boolean"
  | "date";

export interface FieldDef {
  type: FieldType;
  /**
   * For `text` fields: also index an exact-match sub-field, so the same field
   * can be full-text searched AND aggregated/sorted on. In OpenSearch this is
   * the `.keyword` sub-field; other backends express it differently — which is
   * exactly why this is a boolean and not a mapping fragment.
   */
  exactMatch?: boolean;
}

export interface IndexSchema {
  name: string;
  fields: Record<string, FieldDef>;
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "exists";

export type FilterValue = string | number | boolean | Date;

export interface Filter {
  field: string;
  op: FilterOp;
  /** Required for every op except `exists`; an array only for `in`. */
  value?: FilterValue | FilterValue[];
}

/** Full-text match across one or more fields. */
export interface TextQuery {
  fields: string[];
  value: string;
}

export interface Sort {
  field: string;
  direction: "asc" | "desc";
}

export interface SearchQuery {
  text?: TextQuery;
  filters?: Filter[];
  sort?: Sort[];
  limit?: number;
  offset?: number;
}

export interface SearchHit<T> {
  id: string;
  /** Relevance score; null when the query is a pure filter (nothing to rank). */
  score: number | null;
  document: T;
}

export interface SearchResult<T> {
  total: number;
  hits: SearchHit<T>[];
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

export type DateInterval = "minute" | "hour" | "day" | "week" | "month";

/** Views over time. */
export interface DateHistogramAgg {
  kind: "dateHistogram";
  field: string;
  interval: DateInterval;
}

/** Top N by value — e.g. referrers, countries, tags. */
export interface TermsAgg {
  kind: "terms";
  field: string;
  size?: number;
}

/** Approximate distinct count — e.g. uniqueViews via distinct sessionId. */
export interface CardinalityAgg {
  kind: "cardinality";
  field: string;
}

export type Aggregation = DateHistogramAgg | TermsAgg | CardinalityAgg;

export interface AggregateRequest {
  filters?: Filter[];
  /** Named so results come back keyed the same way you asked for them. */
  aggregations: Record<string, Aggregation>;
}

export interface Bucket {
  key: string;
  count: number;
}

export interface AggregateResult {
  /** Documents matching `filters`, before bucketing. */
  total: number;
  /** Results of `dateHistogram` / `terms` aggregations, by their given name. */
  buckets: Record<string, Bucket[]>;
  /** Results of single-value aggregations (`cardinality`), by their given name. */
  values: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type Document = Record<string, unknown>;

export interface BulkDocument {
  id: string;
  document: Document;
}

export interface BulkResult {
  indexed: number;
  failed: number;
  errors: string[];
}
