import type { VectorItem } from "@voltagent/core";
import type { CouchbaseVectorDocument } from "./types.js";

/**
 * The persisted document contract shared by every adapter KV, scan, and query path.
 * `documentType` plus `schemaVersion` is the ownership discriminator: the adapter only reads,
 * replaces, counts, or removes documents that pass {@link isOwnedVectorDocument}, and the
 * Hyperscale partial index filters on the same `documentType` value.
 */
export const VECTOR_DOCUMENT_SCHEMA_VERSION = 1 as const;

export function createVectorDocument(
  item: VectorItem,
  documentType: string,
  dimensions: number,
  createdAt: string,
  updatedAt: string,
): CouchbaseVectorDocument {
  return {
    documentType,
    schemaVersion: VECTOR_DOCUMENT_SCHEMA_VERSION,
    id: item.id,
    vector: [...item.vector],
    dimensions,
    ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
    ...(item.content === undefined ? {} : { content: item.content }),
    createdAt,
    updatedAt,
  };
}

export function isOwnedVectorDocument(
  value: unknown,
  documentType: string,
): value is CouchbaseVectorDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CouchbaseVectorDocument>;
  return (
    candidate.documentType === documentType &&
    candidate.schemaVersion === VECTOR_DOCUMENT_SCHEMA_VERSION &&
    typeof candidate.id === "string" &&
    Array.isArray(candidate.vector)
  );
}

export function toVectorItem(document: CouchbaseVectorDocument): VectorItem {
  return {
    id: document.id,
    vector: [...document.vector],
    ...(document.metadata === undefined ? {} : { metadata: document.metadata }),
    ...(document.content === undefined ? {} : { content: document.content }),
  };
}

/** Prefer the top-level content field, falling back to VoltAgent's metadata.content mirror. */
export function resolveContent(
  content: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  return content ?? (typeof metadata?.content === "string" ? metadata.content : undefined);
}
