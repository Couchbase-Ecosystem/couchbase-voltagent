import { describe, expect, it } from "vitest";
import {
  buildHyperscaleVectorIndexStatement,
  CouchbaseVectorAdapterConfigurationError,
} from "../src/index.js";

describe("buildHyperscaleVectorIndexStatement", () => {
  it("quotes keyspace identifiers and the ownership literal", () => {
    const statement = buildHyperscaleVectorIndexStatement({
      bucketName: "my`bucket",
      scopeName: "scope",
      collectionName: "vectors",
      dimensions: 3,
      documentType: "agent's_vector",
      filterFields: [],
      indexName: "idx_vectors",
    });
    expect(statement).toContain("ON `my``bucket`.`scope`.`vectors` (`vector` VECTOR)");
    expect(statement).toContain("WHERE `documentType` = 'agent''s_vector'");
    expect(statement).not.toContain("INCLUDE");
    expect(statement).toContain('"description":"IVF,SQ8"');
  });

  it("rejects invalid index names", () => {
    expect(() =>
      buildHyperscaleVectorIndexStatement({
        bucketName: "b",
        scopeName: "s",
        collectionName: "c",
        dimensions: 3,
        documentType: "t",
        filterFields: [],
        indexName: "invalid-name",
      }),
    ).toThrow(CouchbaseVectorAdapterConfigurationError);
  });

  it.each([
    [{ dimensions: 0 }, "dimensions"],
    [{ bucketName: "" }, "must not be empty"],
    [{ documentType: "" }, "documentType"],
    [{ description: "" }, "description"],
    [{ filterFields: ["tenantId", "tenantId"] }, "filterFields"],
    [{ filterFields: [""] }, "filterFields"],
  ])("rejects invalid public builder option %j", (override, message) => {
    expect(() =>
      buildHyperscaleVectorIndexStatement({
        bucketName: "b",
        scopeName: "s",
        collectionName: "c",
        dimensions: 3,
        documentType: "t",
        filterFields: [],
        indexName: "idx_vectors",
        ...override,
      }),
    ).toThrow(message);
  });
});
