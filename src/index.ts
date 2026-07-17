import { ValidationError } from "./errors.js";
import { createOpenSearchClient } from "./opensearch/client.js";
import { OpenSearchStore } from "./opensearch/store.js";
import type { SearchStore } from "./store.js";
import type { SearchConfig } from "./types.js";

/**
 * The switch.
 *
 * Consumers call this once at startup and depend only on the returned
 * `SearchStore`. Moving from OpenSearch to another engine means changing
 * `config.driver` — no application code changes, because nothing downstream
 * of this function knows which backend it got.
 *
 * Async because backend clients are optional peer dependencies, loaded on
 * demand rather than at import time.
 */
export async function createSearchStore(config: SearchConfig): Promise<SearchStore> {
  switch (config.driver) {
    case "opensearch": {
      const client = await createOpenSearchClient(config);
      return new OpenSearchStore(client, config.indexPrefix);
    }
    default:
      // Unreachable while SearchDriver has one member; this is the guard that
      // will fail the build when a new driver is added to the union but not here.
      throw new ValidationError(
        `unknown search driver: ${String((config as SearchConfig).driver)}`,
      );
  }
}

export type { SearchStore } from "./store.js";

export type {
  Aggregation,
  AggregateRequest,
  AggregateResult,
  Bucket,
  BulkDocument,
  BulkResult,
  CardinalityAgg,
  DateHistogramAgg,
  DateInterval,
  Document,
  FieldDef,
  FieldType,
  Filter,
  FilterOp,
  FilterValue,
  IndexSchema,
  SearchAuth,
  SearchConfig,
  SearchDriver,
  SearchHit,
  SearchQuery,
  SearchResult,
  Sort,
  TermsAgg,
  TextQuery,
} from "./types.js";

export {
  ConnectionError,
  DocumentNotFoundError,
  DriverNotInstalledError,
  IndexNotFoundError,
  SearchError,
  ValidationError,
} from "./errors.js";

// Exported so consumers can construct a store around a client they already own
// (connection pooling, custom transports), bypassing createSearchStore.
export { OpenSearchStore } from "./opensearch/store.js";
export type { OpenSearchClientLike } from "./opensearch/client.js";
