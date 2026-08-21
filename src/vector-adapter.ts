import type { SearchResult, VectorAdapter, VectorItem, VectorSearchOptions } from "@voltagent/core";
import {
  CasMismatchError,
  type Cluster,
  type Collection,
  connect,
  DocumentExistsError,
  DocumentNotFoundError,
  PrefixScan,
  QueryScanConsistency,
  ServiceType,
} from "couchbase";
import {
  CouchbaseDocumentCollisionError,
  CouchbaseUnsupportedFilterError,
  CouchbaseVectorAdapterConfigurationError,
  CouchbaseVectorValidationError,
} from "./errors.js";
import {
  buildHyperscaleVectorIndexStatement,
  DEFAULT_HYPERSCALE_INDEX_OPTIONS,
} from "./hyperscale-index.js";
import {
  mapWithConcurrency,
  quoteIdentifier,
  quoteStringLiteral,
  validateIndexName,
} from "./internal.js";
import type {
  CouchbaseFilterValue,
  CouchbaseVectorAdapterOptions,
  CouchbaseVectorDocument,
  HyperscaleIndexOptions,
  HyperscaleIndexStatus,
} from "./types.js";

const DEFAULT_SCOPE = "_default";
const DEFAULT_COLLECTION = "voltagent_vectors";
const DEFAULT_DOCUMENT_TYPE = "voltagent_vector";
const DEFAULT_KEY_PREFIX = "voltagent::vector::";
const DEFAULT_FILTER_FIELDS = ["userId", "conversationId"];
const DEFAULT_INDEX_NAME = "voltagent_vectors_hyperscale";
const MAX_CAS_ATTEMPTS = 4;

interface VectorQueryRow {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
  content?: string;
  distance: number;
}

/** Couchbase Server 8.0+ Hyperscale implementation of VoltAgent's VectorAdapter. */
export class CouchbaseVectorAdapter implements VectorAdapter {
  readonly bucketName: string;
  readonly scopeName: string;
  readonly collectionName: string;
  readonly dimensions: number;
  readonly documentType: string;
  readonly keyPrefix: string;
  readonly filterFields: readonly string[];
  readonly indexName: string;

  private readonly options: CouchbaseVectorAdapterOptions;
  private readonly batchConcurrency: number;
  private clusterInstance: Cluster | undefined;
  private collectionInstance: Collection | undefined;
  private connectionPromise: Promise<Cluster> | undefined;
  private ownsCluster = false;
  private closed = false;

  constructor(options: CouchbaseVectorAdapterOptions) {
    validateOptions(options);
    this.options = options;
    this.bucketName = options.bucketName;
    this.scopeName = options.scopeName ?? DEFAULT_SCOPE;
    this.collectionName = options.collectionName ?? DEFAULT_COLLECTION;
    this.dimensions = options.dimensions;
    this.documentType = options.documentType ?? DEFAULT_DOCUMENT_TYPE;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.filterFields = Object.freeze([...(options.filterFields ?? DEFAULT_FILTER_FIELDS)]);
    this.indexName = options.indexName ?? DEFAULT_INDEX_NAME;
    this.batchConcurrency = options.batchConcurrency ?? 20;

    if (options.cluster) {
      this.clusterInstance = options.cluster;
      this.ownsCluster = false;
    }
  }

  async store(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    this.validateId(id);
    this.validateVector(vector);
    const content = typeof metadata?.content === "string" ? metadata.content : undefined;
    await this.writeOwnedDocument({
      id,
      vector: [...vector],
      ...(metadata === undefined ? {} : { metadata }),
      ...(content === undefined ? {} : { content }),
    });
  }

  async storeBatch(items: VectorItem[]): Promise<void> {
    for (const item of items) {
      this.validateId(item.id);
      this.validateVector(item.vector);
    }

    await mapWithConcurrency(items, this.batchConcurrency, async (item) => {
      await this.writeOwnedDocument({
        id: item.id,
        vector: [...item.vector],
        ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
        ...(item.content === undefined ? {} : { content: item.content }),
      });
    });
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<SearchResult[]> {
    this.validateVector(vector);
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0;
    validateSearchBounds(limit, threshold);
    const { predicates, parameters } = this.buildFilter(options.filter);
    const cluster = await this.getCluster();
    const alias = quoteIdentifier("v");
    const distanceExpression = `APPROX_VECTOR_DISTANCE(${alias}.${quoteIdentifier(
      "vector",
    )}, $vector, "COSINE"${this.vectorQueryTuningArguments()})`;
    const statement = [
      `SELECT ${alias}.${quoteIdentifier("id")} AS id,`,
      `       ${alias}.${quoteIdentifier("vector")} AS vector,`,
      `       ${alias}.${quoteIdentifier("metadata")} AS metadata,`,
      `       ${alias}.${quoteIdentifier("content")} AS content,`,
      `       ${distanceExpression} AS distance`,
      `FROM ${this.keyspace()} AS ${alias}`,
      `WHERE ${alias}.${quoteIdentifier("documentType")} = ${quoteStringLiteral(
        this.documentType,
      )}${predicates}`,
      "ORDER BY distance ASC",
      "LIMIT $limit;",
    ].join("\n");

    const result = await cluster.query<VectorQueryRow>(statement, {
      parameters: {
        vector,
        limit,
        ...parameters,
      },
      scanConsistency: QueryScanConsistency.RequestPlus,
      readOnly: true,
      adhoc: false,
    });

    return result.rows
      .map((row) => {
        const score = cosineDistanceToScore(row.distance);
        const content = resolveContent(row.content, row.metadata);
        return {
          id: row.id,
          vector: row.vector,
          ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
          ...(content === undefined ? {} : { content }),
          score,
          distance: row.distance,
        } satisfies SearchResult;
      })
      .filter((row) => row.score >= threshold);
  }

  async delete(id: string): Promise<void> {
    this.validateId(id);
    await this.deleteOwnedDocument(this.documentKey(id));
  }

  async deleteBatch(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.validateId(id);
    }
    await mapWithConcurrency(ids, this.batchConcurrency, async (id) => {
      await this.deleteOwnedDocument(this.documentKey(id));
    });
  }

  /**
   * Removes only adapter-owned documents. Prefix scanning limits the candidate keyspace and the
   * documentType check plus CAS remove prevents unrelated application documents from being deleted.
   */
  async clear(): Promise<void> {
    const collection = await this.getCollection();
    const results = await collection.scan(new PrefixScan(this.keyPrefix));
    await mapWithConcurrency(results, this.batchConcurrency, async (result) => {
      const content = result.content as unknown;
      if (isOwnedVectorDocument(content, this.documentType)) {
        await this.deleteOwnedDocument(result.id);
      }
    });
  }

  async count(): Promise<number> {
    const collection = await this.getCollection();
    const results = await collection.scan(new PrefixScan(this.keyPrefix));
    return results.reduce(
      (count, result) => count + (isOwnedVectorDocument(result.content, this.documentType) ? 1 : 0),
      0,
    );
  }

  async get(id: string): Promise<VectorItem | null> {
    this.validateId(id);
    const collection = await this.getCollection();
    try {
      const result = await collection.get(this.documentKey(id));
      const document = result.content as unknown;
      if (!isOwnedVectorDocument(document, this.documentType)) {
        throw this.collisionError(this.documentKey(id));
      }
      return toVectorItem(document);
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /** Returns the connected SDK cluster for advanced native operations. */
  async getCluster(): Promise<Cluster> {
    if (this.closed) {
      throw new CouchbaseVectorAdapterConfigurationError(
        "This CouchbaseVectorAdapter is closed and cannot be reused",
      );
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    if (this.clusterInstance) {
      return this.clusterInstance;
    }
    this.ownsCluster = true;
    const connectionPromise = (async (): Promise<Cluster> => {
      let cluster: Cluster | undefined;
      try {
        cluster = await connect(this.options.connectionString as string, {
          ...this.options.connectOptions,
          username: this.options.username as string,
          password: this.options.password as string,
        });
        this.clusterInstance = cluster;
        await cluster.waitUntilReady(this.options.readyTimeout ?? 30_000, {
          serviceTypes: [ServiceType.KeyValue, ServiceType.Query],
        });
        return cluster;
      } catch (error) {
        if (cluster) {
          await cluster.close().catch(() => undefined);
        }
        if (this.clusterInstance === cluster) {
          this.clusterInstance = undefined;
          this.collectionInstance = undefined;
        }
        this.connectionPromise = undefined;
        throw error;
      }
    })();
    this.connectionPromise = connectionPromise;
    return this.connectionPromise;
  }

  /** Returns the native SDK collection used by the adapter. */
  async getCollection(): Promise<Collection> {
    if (!this.collectionInstance) {
      const cluster = await this.getCluster();
      this.collectionInstance = cluster
        .bucket(this.bucketName)
        .scope(this.scopeName)
        .collection(this.collectionName);
    }
    return this.collectionInstance;
  }

  /** Build the explicit Server 8.0+ Hyperscale index DDL without executing it. */
  getHyperscaleVectorIndexStatement(options: HyperscaleIndexOptions = {}): string {
    if (options.persistFullVector === false && this.options.rerank === true) {
      throw new CouchbaseVectorAdapterConfigurationError(
        "persistFullVector must remain enabled when adapter queries use rerank",
      );
    }
    return buildHyperscaleVectorIndexStatement({
      bucketName: this.bucketName,
      scopeName: this.scopeName,
      collectionName: this.collectionName,
      dimensions: this.dimensions,
      documentType: this.documentType,
      filterFields: this.filterFields,
      indexName: options.indexName ?? this.indexName,
      description: options.description ?? DEFAULT_HYPERSCALE_INDEX_OPTIONS.description,
      ...(options.scanNProbes === undefined ? {} : { scanNProbes: options.scanNProbes }),
      ...(options.trainList === undefined ? {} : { trainList: options.trainList }),
      ...(options.persistFullVector === undefined
        ? {}
        : { persistFullVector: options.persistFullVector }),
    });
  }

  /** Create the Hyperscale index. Call this during provisioning, not on application startup. */
  async createHyperscaleVectorIndex(options: HyperscaleIndexOptions = {}): Promise<void> {
    const cluster = await this.getCluster();
    const indexName = options.indexName ?? this.indexName;
    validateIndexName(indexName);
    await cluster.query(this.getHyperscaleVectorIndexStatement(options));

    if (options.waitUntilReady ?? DEFAULT_HYPERSCALE_INDEX_OPTIONS.waitUntilReady) {
      const collection = await this.getCollection();
      await collection
        .queryIndexes()
        .watchIndexes([indexName], options.timeout ?? DEFAULT_HYPERSCALE_INDEX_OPTIONS.timeout);
    }
  }

  /** Return the configured index's current Query Service state. */
  async getHyperscaleVectorIndexStatus(
    indexName = this.indexName,
  ): Promise<HyperscaleIndexStatus | null> {
    validateIndexName(indexName);
    const collection = await this.getCollection();
    const indexes = await collection.queryIndexes().getAllIndexes();
    const index = indexes.find((candidate) => candidate.name === indexName);
    return index
      ? { name: index.name, state: index.state, online: index.state === "online" }
      : null;
  }

  /** Close an adapter-owned SDK connection. Injected clusters remain caller-owned. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.ownsCluster) {
      let cluster: Cluster | undefined;
      if (this.connectionPromise) {
        try {
          cluster = await this.connectionPromise;
        } catch {
          // A failed connection is closed and reset by getCluster().
        }
      } else {
        cluster = this.clusterInstance;
      }
      try {
        await cluster?.close();
      } finally {
        this.clusterInstance = undefined;
        this.collectionInstance = undefined;
        this.connectionPromise = undefined;
      }
    }
  }

  private async writeOwnedDocument(item: VectorItem): Promise<void> {
    const collection = await this.getCollection();
    const key = this.documentKey(item.id);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const now = new Date().toISOString();
      const inserted = createDocument(item, this.documentType, this.dimensions, now, now);
      try {
        await collection.insert(key, inserted);
        return;
      } catch (error) {
        if (!(error instanceof DocumentExistsError)) {
          throw error;
        }
      }

      try {
        const current = await collection.get(key);
        const existing = current.content as unknown;
        if (!isOwnedVectorDocument(existing, this.documentType)) {
          throw this.collisionError(key);
        }
        const replacement = createDocument(
          item,
          this.documentType,
          this.dimensions,
          existing.createdAt,
          now,
        );
        await collection.replace(key, replacement, { cas: current.cas });
        return;
      } catch (error) {
        if (error instanceof CasMismatchError || error instanceof DocumentNotFoundError) {
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Unable to store vector ${item.id}: document changed too many times`);
  }

  private async deleteOwnedDocument(key: string): Promise<void> {
    const collection = await this.getCollection();
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      try {
        const current = await collection.get(key);
        if (!isOwnedVectorDocument(current.content, this.documentType)) {
          throw this.collisionError(key);
        }
        await collection.remove(key, { cas: current.cas });
        return;
      } catch (error) {
        if (error instanceof DocumentNotFoundError) {
          return;
        }
        if (error instanceof CasMismatchError) {
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Unable to delete ${key}: document changed too many times`);
  }

  private buildFilter(filter?: Record<string, unknown>): {
    predicates: string;
    parameters: Record<string, CouchbaseFilterValue>;
  } {
    if (!filter || Object.keys(filter).length === 0) {
      return { predicates: "", parameters: {} };
    }
    const allowedFields = new Set(this.filterFields);
    const parameters: Record<string, CouchbaseFilterValue> = {};
    const predicates = Object.entries(filter).map(([field, value], index) => {
      if (!allowedFields.has(field)) {
        throw new CouchbaseUnsupportedFilterError(
          `Filter field "${field}" is not configured. Add it to filterFields and rebuild the Hyperscale index.`,
        );
      }
      if (
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        (typeof value !== "number" || !Number.isFinite(value))
      ) {
        throw new CouchbaseUnsupportedFilterError(
          `Filter field "${field}" must use a string, finite number, or boolean equality value`,
        );
      }
      const parameterName = `filter${index}`;
      parameters[parameterName] = value;
      return ` AND ${quoteIdentifier("v")}.${quoteIdentifier("metadata")}.${quoteIdentifier(
        field,
      )} = $${parameterName}`;
    });
    return { predicates: predicates.join(""), parameters };
  }

  private vectorQueryTuningArguments(): string {
    if (this.options.nProbes === undefined) {
      return "";
    }
    if (this.options.rerank === undefined) {
      return `, ${this.options.nProbes}`;
    }
    if (this.options.topNScan === undefined) {
      return `, ${this.options.nProbes}, ${this.options.rerank ? "TRUE" : "FALSE"}`;
    }
    return `, ${this.options.nProbes}, ${this.options.rerank ? "TRUE" : "FALSE"}, ${
      this.options.topNScan
    }`;
  }

  private keyspace(): string {
    return [this.bucketName, this.scopeName, this.collectionName].map(quoteIdentifier).join(".");
  }

  private documentKey(id: string): string {
    return `${this.keyPrefix}${id}`;
  }

  private validateId(id: string): void {
    if (id.length === 0) {
      throw new CouchbaseVectorValidationError("Vector id must not be empty");
    }
  }

  private validateVector(vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new CouchbaseVectorValidationError(
        `Vector dimension mismatch: expected ${this.dimensions}, received ${vector.length}`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new CouchbaseVectorValidationError("Vector values must all be finite numbers");
    }
  }

  private collisionError(key: string): CouchbaseDocumentCollisionError {
    return new CouchbaseDocumentCollisionError(
      `Document key "${key}" exists but is not owned by this adapter. Use a dedicated collection or a different keyPrefix.`,
    );
  }
}

export function cosineDistanceToScore(distance: number): number {
  if (!Number.isFinite(distance)) {
    throw new CouchbaseVectorValidationError("Couchbase returned a non-finite vector distance");
  }
  return Math.min(1, Math.max(0, 1 - distance / 2));
}

function validateOptions(options: CouchbaseVectorAdapterOptions): void {
  if (!options.bucketName) {
    throw new CouchbaseVectorAdapterConfigurationError("bucketName is required");
  }
  if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
    throw new CouchbaseVectorAdapterConfigurationError("dimensions must be a positive integer");
  }
  const hasCluster = options.cluster !== undefined;
  const hasConnectionValue =
    options.connectionString !== undefined ||
    options.username !== undefined ||
    options.password !== undefined;
  if (hasCluster && hasConnectionValue) {
    throw new CouchbaseVectorAdapterConfigurationError(
      "Provide either cluster or connectionString/username/password, not both",
    );
  }
  if (!hasCluster && (!options.connectionString || !options.username || !options.password)) {
    throw new CouchbaseVectorAdapterConfigurationError(
      "connectionString, username, and password are required when cluster is not supplied",
    );
  }
  if ((options.documentType ?? DEFAULT_DOCUMENT_TYPE).length === 0) {
    throw new CouchbaseVectorAdapterConfigurationError("documentType must not be empty");
  }
  if ((options.keyPrefix ?? DEFAULT_KEY_PREFIX).length === 0) {
    throw new CouchbaseVectorAdapterConfigurationError("keyPrefix must not be empty");
  }
  if (!Number.isInteger(options.batchConcurrency ?? 20) || (options.batchConcurrency ?? 20) <= 0) {
    throw new CouchbaseVectorAdapterConfigurationError(
      "batchConcurrency must be a positive integer",
    );
  }
  if (
    options.readyTimeout !== undefined &&
    (!Number.isInteger(options.readyTimeout) || options.readyTimeout <= 0)
  ) {
    throw new CouchbaseVectorAdapterConfigurationError("readyTimeout must be a positive integer");
  }
  validateIndexName(options.indexName ?? DEFAULT_INDEX_NAME);
  const filterFields = options.filterFields ?? DEFAULT_FILTER_FIELDS;
  if (new Set(filterFields).size !== filterFields.length || filterFields.some((field) => !field)) {
    throw new CouchbaseVectorAdapterConfigurationError(
      "filterFields must contain unique, non-empty metadata keys",
    );
  }
  if (options.rerank !== undefined && options.nProbes === undefined) {
    throw new CouchbaseVectorAdapterConfigurationError("rerank requires nProbes");
  }
  if (
    options.topNScan !== undefined &&
    (options.nProbes === undefined || options.rerank === undefined)
  ) {
    throw new CouchbaseVectorAdapterConfigurationError("topNScan requires nProbes and rerank");
  }
  for (const [name, value] of [
    ["nProbes", options.nProbes],
    ["topNScan", options.topNScan],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new CouchbaseVectorAdapterConfigurationError(`${name} must be a positive integer`);
    }
  }
}

function validateSearchBounds(limit: number, threshold: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CouchbaseVectorValidationError("search limit must be a positive integer");
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new CouchbaseVectorValidationError("search threshold must be between 0 and 1");
  }
}

function createDocument(
  item: VectorItem,
  documentType: string,
  dimensions: number,
  createdAt: string,
  updatedAt: string,
): CouchbaseVectorDocument {
  return {
    documentType,
    schemaVersion: 1,
    id: item.id,
    vector: [...item.vector],
    dimensions,
    ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
    ...(item.content === undefined ? {} : { content: item.content }),
    createdAt,
    updatedAt,
  };
}

function isOwnedVectorDocument(
  value: unknown,
  documentType: string,
): value is CouchbaseVectorDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CouchbaseVectorDocument>;
  return (
    candidate.documentType === documentType &&
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" &&
    Array.isArray(candidate.vector)
  );
}

function toVectorItem(document: CouchbaseVectorDocument): VectorItem {
  return {
    id: document.id,
    vector: [...document.vector],
    ...(document.metadata === undefined ? {} : { metadata: document.metadata }),
    ...(document.content === undefined ? {} : { content: document.content }),
  };
}

function resolveContent(
  content: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  return content ?? (typeof metadata?.content === "string" ? metadata.content : undefined);
}
