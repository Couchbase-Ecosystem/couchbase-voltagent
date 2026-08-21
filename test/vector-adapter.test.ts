import {
  CasMismatchError,
  type Cluster,
  connect,
  DocumentExistsError,
  DocumentNotFoundError,
  type PrefixScan,
} from "couchbase";
import { describe, expect, it, vi } from "vitest";
import {
  CouchbaseDocumentCollisionError,
  CouchbaseUnsupportedFilterError,
  CouchbaseVectorAdapter,
  CouchbaseVectorAdapterConfigurationError,
  CouchbaseVectorValidationError,
  cosineDistanceToScore,
} from "../src/index.js";

vi.mock("couchbase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("couchbase")>();
  return { ...actual, connect: vi.fn() };
});

function ownedDocument(id: string, overrides: Record<string, unknown> = {}) {
  return {
    documentType: "voltagent_vector",
    schemaVersion: 1,
    id,
    vector: [1, 0],
    dimensions: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createHarness(options: Record<string, unknown> = {}) {
  const queryIndexManager = {
    watchIndexes: vi.fn().mockResolvedValue(undefined),
    getAllIndexes: vi.fn().mockResolvedValue([]),
  };
  const collection = {
    insert: vi.fn().mockResolvedValue({}),
    get: vi.fn(),
    replace: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({}),
    scan: vi.fn().mockResolvedValue([]),
    queryIndexes: vi.fn(() => queryIndexManager),
  };
  const scope = { collection: vi.fn(() => collection) };
  const bucket = { scope: vi.fn(() => scope) };
  const cluster = {
    bucket: vi.fn(() => bucket),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const adapter = new CouchbaseVectorAdapter({
    cluster: cluster as unknown as Cluster,
    bucketName: "app",
    scopeName: "ai",
    collectionName: "voltagent_vectors",
    dimensions: 2,
    ...options,
  });
  return { adapter, cluster, collection, bucket, scope };
}

describe("CouchbaseVectorAdapter configuration", () => {
  it("requires a valid connection and dimensions", () => {
    expect(
      () =>
        new CouchbaseVectorAdapter({
          bucketName: "app",
          dimensions: 2,
        }),
    ).toThrow(CouchbaseVectorAdapterConfigurationError);
    expect(
      () =>
        new CouchbaseVectorAdapter({
          cluster: {} as Cluster,
          bucketName: "app",
          dimensions: 0,
        }),
    ).toThrow("dimensions must be a positive integer");
    expect(
      () =>
        new CouchbaseVectorAdapter({
          cluster: {} as Cluster,
          connectionString: "couchbase://localhost",
          username: "u",
          password: "p",
          bucketName: "app",
          dimensions: 2,
        }),
    ).toThrow("not both");
  });

  it.each([
    [{ batchConcurrency: 0 }, "batchConcurrency"],
    [{ documentType: "" }, "documentType"],
    [{ keyPrefix: "" }, "keyPrefix"],
    [{ filterFields: ["userId", "userId"] }, "filterFields"],
    [{ indexName: "bad-name" }, "indexName"],
    [{ rerank: true }, "rerank requires nProbes"],
    [{ nProbes: 1, topNScan: 10 }, "topNScan requires"],
    [{ nProbes: 0 }, "nProbes"],
    [{ readyTimeout: 0 }, "readyTimeout"],
  ])("rejects invalid option %j", (invalid, message) => {
    expect(() => createHarness(invalid)).toThrow(message);
  });
});

describe("CouchbaseVectorAdapter KV behavior", () => {
  it("stores an owned vector without mutating caller data", async () => {
    const { adapter, collection } = createHarness();
    const vector = [1, 0];
    const metadata = { topic: "agents" };

    await adapter.store("doc-1", vector, metadata);

    expect(collection.insert).toHaveBeenCalledOnce();
    const [key, document] = collection.insert.mock.calls[0] as [string, Record<string, unknown>];
    expect(key).toBe("voltagent::vector::doc-1");
    expect(document).toMatchObject({
      documentType: "voltagent_vector",
      schemaVersion: 1,
      id: "doc-1",
      vector: [1, 0],
      dimensions: 2,
      metadata,
    });
    vector[0] = 9;
    expect(document.vector).toEqual([1, 0]);
  });

  it("updates an owned document with CAS and removes stale content omitted by store()", async () => {
    const { adapter, collection } = createHarness();
    collection.insert.mockRejectedValueOnce(new DocumentExistsError());
    collection.get.mockResolvedValueOnce({
      content: ownedDocument("doc-1", { content: "keep me" }),
      cas: 42,
    });

    await adapter.store("doc-1", [0, 1], { topic: "updated" });

    expect(collection.replace).toHaveBeenCalledWith(
      "voltagent::vector::doc-1",
      expect.objectContaining({
        vector: [0, 1],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      { cas: 42 },
    );
    expect(collection.replace.mock.calls[0]?.[1]).not.toHaveProperty("content");
  });

  it("mirrors VoltAgent Memory.addDocument metadata content into the content field", async () => {
    const { adapter, collection } = createHarness();
    await adapter.store("doc-1", [1, 0], { content: "RAG text", topic: "docs" });
    expect(collection.insert.mock.calls[0]?.[1]).toMatchObject({
      content: "RAG text",
      metadata: { content: "RAG text", topic: "docs" },
    });
  });

  it("retries a concurrent CAS update", async () => {
    const { adapter, collection } = createHarness();
    collection.insert.mockRejectedValue(new DocumentExistsError());
    collection.get
      .mockResolvedValueOnce({ content: ownedDocument("doc-1"), cas: 1 })
      .mockResolvedValueOnce({ content: ownedDocument("doc-1"), cas: 2 });
    collection.replace.mockRejectedValueOnce(new CasMismatchError()).mockResolvedValueOnce({});

    await adapter.store("doc-1", [0, 1]);

    expect(collection.replace).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite an unrelated colliding document", async () => {
    const { adapter, collection } = createHarness();
    collection.insert.mockRejectedValueOnce(new DocumentExistsError());
    collection.get.mockResolvedValueOnce({ content: { type: "invoice" }, cas: 1 });

    await expect(adapter.store("doc-1", [1, 0])).rejects.toBeInstanceOf(
      CouchbaseDocumentCollisionError,
    );
    expect(collection.replace).not.toHaveBeenCalled();
  });

  it("stores batches including content and validates before writing", async () => {
    const { adapter, collection } = createHarness({ batchConcurrency: 2 });
    await adapter.storeBatch([
      { id: "one", vector: [1, 0], content: "One" },
      { id: "two", vector: [0, 1], metadata: { userId: "u1" } },
    ]);
    expect(collection.insert).toHaveBeenCalledTimes(2);
    expect(collection.insert.mock.calls[0]?.[1]).toMatchObject({ content: "One" });

    collection.insert.mockClear();
    await expect(
      adapter.storeBatch([
        { id: "valid", vector: [1, 0] },
        { id: "invalid", vector: [1] },
      ]),
    ).rejects.toThrow("dimension mismatch");
    expect(collection.insert).not.toHaveBeenCalled();
  });

  it("gets owned vectors and maps missing documents to null", async () => {
    const { adapter, collection } = createHarness();
    collection.get.mockResolvedValueOnce({
      content: ownedDocument("doc-1", { metadata: { x: 1 }, content: "Hello" }),
    });
    await expect(adapter.get("doc-1")).resolves.toEqual({
      id: "doc-1",
      vector: [1, 0],
      metadata: { x: 1 },
      content: "Hello",
    });

    collection.get.mockRejectedValueOnce(new DocumentNotFoundError());
    await expect(adapter.get("missing")).resolves.toBeNull();
  });

  it("deletes only matching owned documents and tolerates missing IDs", async () => {
    const { adapter, collection } = createHarness();
    collection.get.mockResolvedValueOnce({ content: ownedDocument("doc-1"), cas: 7 });
    await adapter.delete("doc-1");
    expect(collection.remove).toHaveBeenCalledWith("voltagent::vector::doc-1", { cas: 7 });

    collection.get.mockRejectedValueOnce(new DocumentNotFoundError());
    await expect(adapter.delete("missing")).resolves.toBeUndefined();
  });

  it("retries delete CAS conflicts and rejects unrelated documents", async () => {
    const { adapter, collection } = createHarness();
    collection.get
      .mockResolvedValueOnce({ content: ownedDocument("doc-1"), cas: 1 })
      .mockResolvedValueOnce({ content: ownedDocument("doc-1"), cas: 2 });
    collection.remove.mockRejectedValueOnce(new CasMismatchError()).mockResolvedValueOnce({});
    await adapter.delete("doc-1");
    expect(collection.remove).toHaveBeenCalledTimes(2);

    collection.get.mockResolvedValueOnce({ content: { type: "invoice" }, cas: 3 });
    await expect(adapter.delete("collision")).rejects.toBeInstanceOf(
      CouchbaseDocumentCollisionError,
    );
  });

  it("clear scans only the prefix and discriminator-checks every deletion", async () => {
    const { adapter, collection } = createHarness();
    collection.scan.mockResolvedValueOnce([
      { id: "voltagent::vector::owned", content: ownedDocument("owned") },
      { id: "voltagent::vector::invoice", content: { documentType: "invoice" } },
    ]);
    collection.get.mockResolvedValueOnce({ content: ownedDocument("owned"), cas: 8 });

    await adapter.clear();

    const scan = collection.scan.mock.calls[0]?.[0] as PrefixScan;
    expect(scan.prefix).toBe("voltagent::vector::");
    expect(collection.remove).toHaveBeenCalledOnce();
    expect(collection.remove).toHaveBeenCalledWith("voltagent::vector::owned", { cas: 8 });
  });

  it("count includes only documents with the ownership discriminator", async () => {
    const { adapter, collection } = createHarness();
    collection.scan.mockResolvedValueOnce([
      { content: ownedDocument("one") },
      { content: ownedDocument("two") },
      { content: { documentType: "invoice" } },
    ]);
    await expect(adapter.count()).resolves.toBe(2);
  });

  it("does not close a caller-owned cluster", async () => {
    const { adapter, cluster } = createHarness();
    await adapter.close();
    await adapter.close();
    expect(cluster.close).not.toHaveBeenCalled();
    await expect(adapter.getCluster()).rejects.toThrow("closed");
  });

  it("closes a cluster that fails readiness and allows a fresh connection attempt", async () => {
    let rejectReadiness: ((reason: Error) => void) | undefined;
    const readiness = new Promise<void>((_resolve, reject) => {
      rejectReadiness = reject;
    });
    const firstCluster = {
      waitUntilReady: vi.fn(() => readiness),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const secondCluster = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const connectMock = vi.mocked(connect);
    connectMock.mockReset();
    connectMock
      .mockResolvedValueOnce(firstCluster as unknown as Cluster)
      .mockResolvedValueOnce(secondCluster as unknown as Cluster);
    const adapter = new CouchbaseVectorAdapter({
      connectionString: "couchbase://localhost",
      username: "user",
      password: "secret",
      bucketName: "app",
      dimensions: 2,
    });

    const firstAttempt = adapter.getCluster();
    await vi.waitFor(() => expect(firstCluster.waitUntilReady).toHaveBeenCalledOnce());
    const concurrentAttempt = adapter.getCluster();
    const firstExpectation = expect(firstAttempt).rejects.toThrow("Query Service unavailable");
    const concurrentExpectation = expect(concurrentAttempt).rejects.toThrow(
      "Query Service unavailable",
    );
    rejectReadiness?.(new Error("Query Service unavailable"));
    await firstExpectation;
    await concurrentExpectation;
    expect(firstCluster.close).toHaveBeenCalledOnce();
    await expect(adapter.getCluster()).resolves.toBe(secondCluster);
    expect(connectMock).toHaveBeenCalledTimes(2);

    await adapter.close();
    expect(secondCluster.close).toHaveBeenCalledOnce();
    connectMock.mockReset();
  });

  it("waits for readiness before closing an in-progress owned connection", async () => {
    let markReady: (() => void) | undefined;
    const readiness = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const cluster = {
      waitUntilReady: vi.fn(() => readiness),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const connectMock = vi.mocked(connect);
    connectMock.mockReset();
    connectMock.mockResolvedValueOnce(cluster as unknown as Cluster);
    const adapter = new CouchbaseVectorAdapter({
      connectionString: "couchbase://localhost",
      username: "user",
      password: "secret",
      bucketName: "app",
      dimensions: 2,
    });

    const connection = adapter.getCluster();
    await vi.waitFor(() => expect(cluster.waitUntilReady).toHaveBeenCalledOnce());
    const closing = adapter.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(cluster.close).not.toHaveBeenCalled();
    markReady?.();
    await connection;
    await closing;
    expect(cluster.close).toHaveBeenCalledOnce();
    await expect(adapter.getCluster()).rejects.toThrow("closed");
    connectMock.mockReset();
  });
});

describe("CouchbaseVectorAdapter Hyperscale search", () => {
  it("uses APPROX_VECTOR_DISTANCE, prefilters metadata, and normalizes scores", async () => {
    const { adapter, cluster } = createHarness({ nProbes: 4, rerank: true, topNScan: 50 });
    cluster.query.mockResolvedValueOnce({
      rows: [
        { id: "same", vector: [1, 0], content: "same", distance: 0 },
        { id: "orthogonal", vector: [0, 1], content: "other", distance: 1 },
      ],
    });

    const results = await adapter.search([1, 0], {
      limit: 5,
      threshold: 0.6,
      filter: { userId: "u1", conversationId: "c1" },
    });

    const [statement, queryOptions] = cluster.query.mock.calls[0] as [
      string,
      { parameters: Record<string, unknown>; readOnly: boolean },
    ];
    expect(statement).toContain(
      'APPROX_VECTOR_DISTANCE(`v`.`vector`, $vector, "COSINE", 4, TRUE, 50)',
    );
    expect(statement).toContain("`v`.`documentType` = 'voltagent_vector'");
    expect(statement).toContain("`v`.`metadata`.`userId` = $filter0");
    expect(statement).toContain("ORDER BY distance ASC");
    expect(queryOptions.parameters).toMatchObject({
      vector: [1, 0],
      limit: 5,
      filter0: "u1",
      filter1: "c1",
    });
    expect(queryOptions.readOnly).toBe(true);
    expect(results).toEqual([expect.objectContaining({ id: "same", score: 1, distance: 0 })]);
  });

  it("rejects filters the Hyperscale index cannot prefilter", async () => {
    const { adapter, cluster } = createHarness();
    await expect(adapter.search([1, 0], { filter: { category: "docs" } })).rejects.toBeInstanceOf(
      CouchbaseUnsupportedFilterError,
    );
    await expect(adapter.search([1, 0], { filter: { userId: ["u1"] } })).rejects.toThrow(
      "finite number",
    );
    await expect(adapter.search([1, 0], { filter: { userId: Number.NaN } })).rejects.toThrow(
      "finite number",
    );
    expect(cluster.query).not.toHaveBeenCalled();
  });

  it.each([
    [[1], {}, "dimension mismatch"],
    [[1, Number.NaN], {}, "finite"],
    [[1, 0], { limit: 0 }, "positive integer"],
    [[1, 0], { threshold: 2 }, "between 0 and 1"],
  ])("validates vector search input", async (vector, options, message) => {
    const { adapter } = createHarness();
    await expect(adapter.search(vector as number[], options)).rejects.toThrow(message as string);
  });

  it("converts cosine distance to VoltAgent score bounds", () => {
    expect(cosineDistanceToScore(0)).toBe(1);
    expect(cosineDistanceToScore(1)).toBe(0.5);
    expect(cosineDistanceToScore(2)).toBe(0);
    expect(cosineDistanceToScore(-1)).toBe(1);
    expect(cosineDistanceToScore(3)).toBe(0);
    expect(() => cosineDistanceToScore(Number.NaN)).toThrow(CouchbaseVectorValidationError);
  });
});

describe("CouchbaseVectorAdapter index lifecycle", () => {
  it("builds safe Hyperscale COSINE DDL with configured filters", () => {
    const { adapter } = createHarness();
    expect(adapter.getHyperscaleVectorIndexStatement()).toBe(
      [
        "CREATE VECTOR INDEX IF NOT EXISTS `voltagent_vectors_hyperscale`",
        "ON `app`.`ai`.`voltagent_vectors` (`vector` VECTOR) INCLUDE (`metadata`.`userId`, `metadata`.`conversationId`)",
        "WHERE `documentType` = 'voltagent_vector'",
        'WITH {"dimension":2,"similarity":"COSINE","description":"IVF,SQ8"};',
      ].join("\n"),
    );
  });

  it("creates, waits for, and reports the index", async () => {
    const { adapter, cluster, collection } = createHarness();
    const managers = collection.queryIndexes();
    managers.getAllIndexes.mockResolvedValueOnce([
      { name: "voltagent_vectors_hyperscale", state: "online" },
    ]);

    await adapter.createHyperscaleVectorIndex({ timeout: 500 });
    expect(cluster.query).toHaveBeenCalledWith(expect.stringContaining("CREATE VECTOR INDEX"));
    expect(managers.watchIndexes).toHaveBeenCalledWith(["voltagent_vectors_hyperscale"], 500);
    await expect(adapter.getHyperscaleVectorIndexStatus()).resolves.toEqual({
      name: "voltagent_vectors_hyperscale",
      state: "online",
      online: true,
    });
  });

  it("can skip readiness waiting and reports a missing index", async () => {
    const { adapter, collection } = createHarness();
    const managers = collection.queryIndexes();
    await adapter.createHyperscaleVectorIndex({ waitUntilReady: false });
    expect(managers.watchIndexes).not.toHaveBeenCalled();
    await expect(adapter.getHyperscaleVectorIndexStatus()).resolves.toBeNull();
  });
});
