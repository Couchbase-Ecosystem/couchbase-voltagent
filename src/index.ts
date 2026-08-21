export {
  CouchbaseDocumentCollisionError,
  CouchbaseUnsupportedFilterError,
  CouchbaseVectorAdapterConfigurationError,
  CouchbaseVectorValidationError,
} from "./errors.js";
export {
  buildHyperscaleVectorIndexStatement,
  DEFAULT_HYPERSCALE_INDEX_OPTIONS,
  type HyperscaleIndexStatementOptions,
} from "./hyperscale-index.js";
export type {
  CouchbaseFilterValue,
  CouchbaseVectorAdapterOptions,
  CouchbaseVectorDocument,
  HyperscaleIndexOptions,
  HyperscaleIndexStatus,
} from "./types.js";
export { CouchbaseVectorAdapter, cosineDistanceToScore } from "./vector-adapter.js";
