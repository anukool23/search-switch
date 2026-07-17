import type {
  AggregateRequest,
  AggregateResult,
  BulkDocument,
  BulkResult,
  Document,
  IndexSchema,
  SearchQuery,
  SearchResult,
} from "./types.js";

/**
 * The contract every backend implements.
 *
 * This is the search-switch equivalent of `dbswitch.Store`: consumers depend on
 * this interface, never on a concrete driver. `createSearchStore()` picks the
 * implementation from config, so swapping OpenSearch → Meilisearch changes one
 * env var and nothing else.
 *
 * Index names passed here are *logical* — the driver applies `indexPrefix` from
 * config, so callers say "views" and get "lumea-prod-views" transparently.
 */
export interface SearchStore {
  /** Create the index if absent, and register its schema. Idempotent — safe to call on every boot. */
  createIndex(schema: IndexSchema): Promise<void>;

  deleteIndex(name: string): Promise<void>;

  indexExists(name: string): Promise<boolean>;

  /** Insert or replace a single document by id. */
  index(indexName: string, id: string, document: Document): Promise<void>;

  /** Insert or replace many documents in one round trip. Partial failure is reported, not thrown. */
  bulkIndex(indexName: string, documents: BulkDocument[]): Promise<BulkResult>;

  /** Fetch one document by id. Resolves to null when absent — absence is not exceptional. */
  get<T = Document>(indexName: string, id: string): Promise<T | null>;

  /** Full-text search and/or filter. */
  search<T = Document>(indexName: string, query: SearchQuery): Promise<SearchResult<T>>;

  /** Bucket and summarise. Returns no documents. */
  aggregate(indexName: string, request: AggregateRequest): Promise<AggregateResult>;

  /** Delete one document by id. Deleting an absent document is not an error. */
  delete(indexName: string, id: string): Promise<void>;

  /** Release connections. */
  close(): Promise<void>;
}
