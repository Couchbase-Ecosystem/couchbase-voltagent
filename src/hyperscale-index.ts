import { CouchbaseVectorAdapterConfigurationError } from "./errors.js";
import { quoteIdentifier, quoteStringLiteral, validateIndexName } from "./internal.js";
import type { HyperscaleIndexOptions } from "./types.js";

export interface HyperscaleIndexStatementOptions {
  bucketName: string;
  scopeName: string;
  collectionName: string;
  dimensions: number;
  documentType: string;
  filterFields: readonly string[];
  indexName: string;
  description?: string;
}

/**
 * Builds the explicit Couchbase Server 8.0+ Hyperscale vector-index DDL.
 * The partial-index predicate is part of the adapter's document isolation boundary.
 */
export function buildHyperscaleVectorIndexStatement(
  options: HyperscaleIndexStatementOptions,
): string {
  validateIndexName(options.indexName);
  if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
    throw new CouchbaseVectorAdapterConfigurationError("dimensions must be a positive integer");
  }
  if (!options.bucketName || !options.scopeName || !options.collectionName) {
    throw new CouchbaseVectorAdapterConfigurationError(
      "bucketName, scopeName, and collectionName must not be empty",
    );
  }
  if (!options.documentType) {
    throw new CouchbaseVectorAdapterConfigurationError("documentType must not be empty");
  }
  if (options.description !== undefined && options.description.length === 0) {
    throw new CouchbaseVectorAdapterConfigurationError("description must not be empty");
  }
  if (
    new Set(options.filterFields).size !== options.filterFields.length ||
    options.filterFields.some((field) => !field)
  ) {
    throw new CouchbaseVectorAdapterConfigurationError(
      "filterFields must contain unique, non-empty metadata keys",
    );
  }
  const keyspace = [options.bucketName, options.scopeName, options.collectionName]
    .map(quoteIdentifier)
    .join(".");
  const include = options.filterFields.length
    ? ` INCLUDE (${options.filterFields
        .map((field) => `${quoteIdentifier("metadata")}.${quoteIdentifier(field)}`)
        .join(", ")})`
    : "";
  const withOptions = {
    dimension: options.dimensions,
    similarity: "COSINE",
    description: options.description ?? "IVF,SQ8",
  };

  return [
    `CREATE VECTOR INDEX IF NOT EXISTS ${quoteIdentifier(options.indexName)}`,
    `ON ${keyspace} (${quoteIdentifier("vector")} VECTOR)${include}`,
    `WHERE ${quoteIdentifier("documentType")} = ${quoteStringLiteral(options.documentType)}`,
    `WITH ${JSON.stringify(withOptions)};`,
  ].join("\n");
}

export const DEFAULT_HYPERSCALE_INDEX_OPTIONS: Required<
  Pick<HyperscaleIndexOptions, "description" | "waitUntilReady" | "timeout">
> = {
  description: "IVF,SQ8",
  waitUntilReady: true,
  timeout: 120_000,
};
