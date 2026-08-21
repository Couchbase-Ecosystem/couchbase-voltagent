import type { ConnectOptions } from "couchbase";

/** Scalar metadata values supported by Hyperscale pre-filtering. */
export type CouchbaseFilterValue = string | number | boolean;

/** The JSON document stored by the adapter. */
export interface CouchbaseVectorDocument {
  documentType: string;
  schemaVersion: 1;
  id: string;
  vector: number[];
  dimensions: number;
  metadata?: Record<string, unknown>;
  content?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CouchbaseVectorAdapterOptions {
  /** An existing SDK cluster. When supplied, close() does not close it. */
  cluster?: import("couchbase").Cluster;
  /** Couchbase connection string, for example couchbases://cb.example.cloud.couchbase.com. */
  connectionString?: string;
  /** Database username. Required with connectionString. */
  username?: string;
  /** Database password. Required with connectionString. */
  password?: string;
  /** Additional SDK connection options. username and password are set by this adapter. */
  connectOptions?: Omit<ConnectOptions, "username" | "password">;
  /** Time to wait for KV and Query services after connecting. Defaults to 30000 ms. */
  readyTimeout?: number;
  bucketName: string;
  /** Defaults to _default. */
  scopeName?: string;
  /** Defaults to voltagent_vectors, a dedicated collection name. */
  collectionName?: string;
  /** Exact embedding dimension used by the Hyperscale index. */
  dimensions: number;
  /** Partial-index and document ownership marker. Defaults to voltagent_vector. */
  documentType?: string;
  /** Prefix used for adapter-owned document keys. Defaults to voltagent::vector::. */
  keyPrefix?: string;
  /** Metadata keys allowed in search filters and included in the Hyperscale index. */
  filterFields?: string[];
  /** Default Hyperscale index name. */
  indexName?: string;
  /** Maximum simultaneous KV operations for batches. Defaults to 20. */
  batchConcurrency?: number;
  /** Number of centroids to probe during search. Uses the index default when omitted. */
  nProbes?: number;
  /** Re-rank candidates using full vectors. Requires nProbes. */
  rerank?: boolean;
  /** Maximum candidate records scanned. Requires nProbes and rerank. */
  topNScan?: number;
}

export interface HyperscaleIndexOptions {
  /** Defaults to the adapter's indexName. */
  indexName?: string;
  /** Hyperscale algorithm and quantization. Defaults to IVF,SQ8. */
  description?: string;
  /** Default number of centroids to probe when a query does not supply nProbes. */
  scanNProbes?: number;
  /** Number of vectors sampled to train the index. Couchbase permits at most 1,000,000. */
  trainList?: number;
  /** Store full vectors for reranking. Defaults to true in Couchbase Server. */
  persistFullVector?: boolean;
  /** Wait for the index to become online. Defaults to true. */
  waitUntilReady?: boolean;
  /** Index readiness timeout in milliseconds. Defaults to 120000. */
  timeout?: number;
}

export interface HyperscaleIndexStatus {
  name: string;
  state: string;
  online: boolean;
}
