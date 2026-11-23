import { describe, expect, it } from "vitest";
import {
  createVectorDocument,
  isOwnedVectorDocument,
  resolveContent,
  toVectorItem,
  VECTOR_DOCUMENT_SCHEMA_VERSION,
} from "../src/vector-document.js";

const now = "2026-01-01T00:00:00.000Z";

describe("vector document contract", () => {
  it("round-trips an item through the stored document without sharing the vector array", () => {
    const item = { id: "a", vector: [1, 0], metadata: { userId: "u1" }, content: "hello" };
    const document = createVectorDocument(item, "voltagent_vector", 2, now, now);

    expect(document).toEqual({
      documentType: "voltagent_vector",
      schemaVersion: VECTOR_DOCUMENT_SCHEMA_VERSION,
      id: "a",
      vector: [1, 0],
      dimensions: 2,
      metadata: { userId: "u1" },
      content: "hello",
      createdAt: now,
      updatedAt: now,
    });
    expect(document.vector).not.toBe(item.vector);
    expect(isOwnedVectorDocument(document, "voltagent_vector")).toBe(true);

    const roundTripped = toVectorItem(document);
    expect(roundTripped).toEqual(item);
    expect(roundTripped.vector).not.toBe(document.vector);
  });

  it("omits optional fields instead of storing undefined", () => {
    const document = createVectorDocument({ id: "a", vector: [1] }, "t", 1, now, now);
    expect(Object.keys(document)).not.toContain("metadata");
    expect(Object.keys(document)).not.toContain("content");
    expect(Object.keys(toVectorItem(document))).toEqual(["id", "vector"]);
  });

  it.each([
    ["null", null],
    ["a string", "voltagent_vector"],
    ["another documentType", { documentType: "other", schemaVersion: 1, id: "a", vector: [] }],
    ["an unknown schemaVersion", { documentType: "t", schemaVersion: 2, id: "a", vector: [] }],
    ["a non-string id", { documentType: "t", schemaVersion: 1, id: 1, vector: [] }],
    ["a missing vector", { documentType: "t", schemaVersion: 1, id: "a" }],
  ])("does not treat %s as adapter-owned", (_label, value) => {
    expect(isOwnedVectorDocument(value, "t")).toBe(false);
  });

  it("resolves content from the field, then from metadata.content", () => {
    expect(resolveContent("field", { content: "meta" })).toBe("field");
    expect(resolveContent(undefined, { content: "meta" })).toBe("meta");
    expect(resolveContent(undefined, { content: 1 })).toBeUndefined();
    expect(resolveContent(undefined, undefined)).toBeUndefined();
  });
});
