import {
  ConnectionError,
  IndexNotFoundError,
  SearchError,
} from "../errors.js";
import type { SearchStore } from "../store.js";
import type {
  AggregateRequest,
  AggregateResult,
  BulkDocument,
  BulkResult,
  Document,
  FieldDef,
  IndexSchema,
  SearchHit,
  SearchQuery,
  SearchResult,
} from "../types.js";
import { buildAggregations, parseAggregations } from "./aggregations.js";
import type { OpenSearchClientLike } from "./client.js";
import { fromMappingProperties, toMappingProperties } from "./mapping.js";
import { buildQuery, buildSort, type FieldResolver } from "./query.js";

const DEFAULT_LIMIT = 20;

export class OpenSearchStore implements SearchStore {
  private readonly client: OpenSearchClientLike;
  private readonly prefix: string;
  /** Physical index name → its fields. Populated by createIndex, or lazily from the cluster. */
  private readonly schemas = new Map<string, Record<string, FieldDef>>();

  constructor(client: OpenSearchClientLike, indexPrefix?: string) {
    this.client = client;
    this.prefix = indexPrefix ?? "";
  }

  private physical(name: string): string {
    return `${this.prefix}${name}`;
  }

  async createIndex(schema: IndexSchema): Promise<void> {
    const index = this.physical(schema.name);
    // Register regardless of whether we create it — an existing index still
    // needs its schema known for field resolution.
    this.schemas.set(index, schema.fields);

    if (await this.indexExists(schema.name)) return;

    try {
      await this.client.indices.create({
        index,
        body: { mappings: { properties: toMappingProperties(schema.fields) } },
      });
    } catch (cause) {
      // Concurrent boots (e.g. several Lambdas cold-starting at once) can race
      // here; losing the race is not a failure.
      if (errorType(cause) === "resource_already_exists_exception") return;
      throw this.translate(cause, index);
    }
  }

  async deleteIndex(name: string): Promise<void> {
    const index = this.physical(name);
    this.schemas.delete(index);
    try {
      await this.client.indices.delete({ index });
    } catch (cause) {
      if (statusOf(cause) === 404) return;
      throw this.translate(cause, index);
    }
  }

  async indexExists(name: string): Promise<boolean> {
    const index = this.physical(name);
    try {
      const res = await this.client.indices.exists({ index });
      // The client reports existence via statusCode; older versions also set
      // body to a boolean. Accept either.
      if (typeof res?.body === "boolean") return res.body;
      return res?.statusCode === 200;
    } catch (cause) {
      if (statusOf(cause) === 404) return false;
      throw this.translate(cause, index);
    }
  }

  async index(indexName: string, id: string, document: Document): Promise<void> {
    const index = this.physical(indexName);
    try {
      await this.client.index({ index, id, body: document, refresh: false });
    } catch (cause) {
      throw this.translate(cause, index);
    }
  }

  async bulkIndex(indexName: string, documents: BulkDocument[]): Promise<BulkResult> {
    if (documents.length === 0) return { indexed: 0, failed: 0, errors: [] };

    const index = this.physical(indexName);
    const operations: unknown[] = [];
    for (const doc of documents) {
      operations.push({ index: { _index: index, _id: doc.id } });
      operations.push(doc.document);
    }

    let res: { body?: { items?: unknown[]; errors?: boolean } };
    try {
      res = await this.client.bulk({ body: operations, refresh: false });
    } catch (cause) {
      throw this.translate(cause, index);
    }

    // Bulk reports per-item outcomes rather than throwing: a partial failure is
    // a normal result the caller decides how to handle, not an exception.
    const items = res?.body?.items ?? [];
    let indexed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const item of items) {
      const outcome = (item as { index?: { error?: { reason?: unknown } } }).index;
      const reason = outcome?.error?.reason;
      if (outcome?.error !== undefined) {
        failed += 1;
        errors.push(typeof reason === "string" ? reason : "unknown bulk error");
      } else {
        indexed += 1;
      }
    }

    return { indexed, failed, errors };
  }

  async get<T = Document>(indexName: string, id: string): Promise<T | null> {
    const index = this.physical(indexName);
    try {
      const res = await this.client.get({ index, id });
      const source = res?.body?._source;
      return source === undefined ? null : (source as T);
    } catch (cause) {
      if (statusOf(cause) === 404) return null;
      throw this.translate(cause, index);
    }
  }

  async search<T = Document>(
    indexName: string,
    query: SearchQuery,
  ): Promise<SearchResult<T>> {
    const index = this.physical(indexName);
    const resolve = await this.resolverFor(index);

    const body: Record<string, unknown> = {
      query: buildQuery(query, resolve),
      // Without this the reported total saturates at 10,000 and pagination lies.
      track_total_hits: true,
      size: query.limit ?? DEFAULT_LIMIT,
      from: query.offset ?? 0,
    };

    const sort = buildSort(query.sort, resolve);
    if (sort !== undefined) body["sort"] = sort;

    let res: { body?: { hits?: { total?: unknown; hits?: unknown[] } } };
    try {
      res = await this.client.search({ index, body });
    } catch (cause) {
      throw this.translate(cause, index);
    }

    const rawHits = res?.body?.hits?.hits ?? [];
    const hits: SearchHit<T>[] = rawHits.map((h) => {
      const hit = h as { _id?: unknown; _score?: unknown; _source?: unknown };
      return {
        id: String(hit._id ?? ""),
        score: typeof hit._score === "number" ? hit._score : null,
        document: hit._source as T,
      };
    });

    return { total: totalOf(res?.body?.hits?.total), hits };
  }

  async aggregate(
    indexName: string,
    request: AggregateRequest,
  ): Promise<AggregateResult> {
    const index = this.physical(indexName);
    const resolve = await this.resolverFor(index);

    const body: Record<string, unknown> = {
      // Aggregations only — the caller wants summaries, not documents.
      size: 0,
      track_total_hits: true,
      query: buildQuery({ ...(request.filters ? { filters: request.filters } : {}) }, resolve),
      aggs: buildAggregations(request.aggregations, resolve),
    };

    let res: { body?: { hits?: { total?: unknown }; aggregations?: unknown } };
    try {
      res = await this.client.search({ index, body });
    } catch (cause) {
      throw this.translate(cause, index);
    }

    const { buckets, values } = parseAggregations(
      res?.body?.aggregations,
      request.aggregations,
    );

    return { total: totalOf(res?.body?.hits?.total), buckets, values };
  }

  async delete(indexName: string, id: string): Promise<void> {
    const index = this.physical(indexName);
    try {
      await this.client.delete({ index, id });
    } catch (cause) {
      if (statusOf(cause) === 404) return;
      throw this.translate(cause, index);
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Builds a field resolver from the index's schema, so `tags` becomes
   * `tags.keyword` when tags is analyzed text with an exact-match twin.
   */
  private async resolverFor(index: string): Promise<FieldResolver> {
    const schema = await this.schemaFor(index);
    if (schema === undefined) return (field) => field;

    return (field, exact) => {
      if (!exact) return field;
      const def = schema[field];
      if (def?.type === "text" && def.exactMatch === true) {
        return `${field}.keyword`;
      }
      return field;
    };
  }

  private async schemaFor(index: string): Promise<Record<string, FieldDef> | undefined> {
    const registered = this.schemas.get(index);
    if (registered !== undefined) return registered;

    // Not registered — recover it from the cluster so aggregations on text
    // fields don't silently bucket on analyzed tokens.
    try {
      const res = await this.client.indices.getMapping({ index });
      const properties = res?.body?.[index]?.mappings?.properties;
      if (typeof properties !== "object" || properties === null) return undefined;

      const fields = fromMappingProperties(properties as Record<string, unknown>);
      this.schemas.set(index, fields);
      return fields;
    } catch {
      // A missing mapping is not worth failing the query over — fall back to
      // passthrough and let the actual request surface any real error.
      return undefined;
    }
  }

  private translate(cause: unknown, index: string): Error {
    if (errorType(cause) === "index_not_found_exception" || statusOf(cause) === 404) {
      return new IndexNotFoundError(index, { cause });
    }

    const code = (cause as { code?: unknown })?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      return new ConnectionError(`cannot reach OpenSearch: ${String(code)}`, { cause });
    }

    const name = (cause as { name?: unknown })?.name;
    if (name === "ConnectionError" || name === "TimeoutError" || name === "NoLivingConnectionsError") {
      return new ConnectionError(`cannot reach OpenSearch: ${String(name)}`, { cause });
    }

    const message = cause instanceof Error ? cause.message : String(cause);
    return new SearchError(`opensearch request failed: ${message}`, { cause });
  }
}

function statusOf(cause: unknown): number | undefined {
  const status = (cause as { statusCode?: unknown; meta?: { statusCode?: unknown } })
    ?.statusCode;
  if (typeof status === "number") return status;

  const metaStatus = (cause as { meta?: { statusCode?: unknown } })?.meta?.statusCode;
  return typeof metaStatus === "number" ? metaStatus : undefined;
}

function errorType(cause: unknown): string | undefined {
  const body = (cause as { body?: unknown; meta?: { body?: unknown } })?.body ??
    (cause as { meta?: { body?: unknown } })?.meta?.body;

  const type = (body as { error?: { type?: unknown } })?.error?.type;
  return typeof type === "string" ? type : undefined;
}

/** OpenSearch returns total as `{ value, relation }` (modern) or a bare number (legacy). */
function totalOf(total: unknown): number {
  if (typeof total === "number") return total;
  const value = (total as { value?: unknown })?.value;
  return typeof value === "number" ? value : 0;
}
