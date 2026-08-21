import { type EmbeddingAdapter, InMemoryStorageAdapter, Memory } from "@voltagent/core";
import { CollectionExistsError, DocumentNotFoundError, ScopeExistsError } from "couchbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CouchbaseVectorAdapter } from "../src/index.js";

const live = process.env.CB_LIVE_TEST === "1" ? describe.sequential : describe.skip;

class LiveEmbedding implements EmbeddingAdapter {
  async embed(text: string): Promise<number[]> {
    return text.toLowerCase().includes("couchbase") ? [1, 0] : [0, 1];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimensions(): number {
    return 2;
  }

  getModelName(): string {
    return "live-contract-embedding";
  }
}

live("CouchbaseVectorAdapter live Couchbase Server 8", () => {
  const scopeName = "voltagent_test";
  const collectionName = "vectors";
  const bucketName = process.env.CB_BUCKET ?? "voltagent";
  const adapter = new CouchbaseVectorAdapter({
    connectionString: process.env.CB_CONNECTION_STRING ?? "couchbase://127.0.0.1",
    username: process.env.CB_USERNAME ?? "Administrator",
    password: process.env.CB_PASSWORD ?? "password",
    bucketName,
    scopeName,
    collectionName,
    dimensions: 2,
    filterFields: ["userId", "conversationId"],
    indexName: "voltagent_test_hyperscale",
  });

  beforeAll(async () => {
    const cluster = await adapter.getCluster();
    const manager = cluster.bucket(bucketName).collections();
    try {
      await manager.createScope(scopeName);
    } catch (error) {
      if (!(error instanceof ScopeExistsError)) throw error;
    }
    try {
      await manager.createCollection(collectionName, scopeName);
    } catch (error) {
      if (!(error instanceof CollectionExistsError)) throw error;
    }

    const collection = await adapter.getCollection();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await collection.upsert("integration-ready", { ready: true });
        await collection.remove("integration-ready");
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    await adapter.storeBatch([
      {
        id: "couchbase",
        vector: [1, 0],
        content: "Couchbase is an operational database for AI applications.",
        metadata: { userId: "u1", conversationId: "c1" },
      },
      {
        id: "voltagent",
        vector: [0.9, 0.1],
        content: "VoltAgent is a TypeScript framework for AI agents.",
        metadata: { userId: "u1", conversationId: "c1" },
      },
      {
        id: "unrelated-vector",
        vector: [0, 1],
        content: "An unrelated document.",
        metadata: { userId: "u2", conversationId: "c2" },
      },
    ]);
    await adapter.createHyperscaleVectorIndex();
  });

  afterAll(async () => {
    const cluster = await adapter.getCluster();
    await cluster.bucket(bucketName).collections().dropScope(scopeName);
    await adapter.close();
  });

  it("runs an end-to-end filtered Hyperscale vector query", async () => {
    const results = await adapter.search([1, 0], {
      limit: 2,
      threshold: 0.5,
      filter: { userId: "u1", conversationId: "c1" },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("couchbase");
    expect(results[0]?.score).toBeGreaterThan(0.9);
  });

  it("works through VoltAgent Memory.addDocument and searchSimilar", async () => {
    const memory = new Memory({
      storage: new InMemoryStorageAdapter(),
      embedding: new LiveEmbedding(),
      vector: adapter,
    });

    try {
      await memory.addDocument({
        id: "memory-contract",
        content: "Couchbase live VoltAgent contract verification.",
        metadata: {
          userId: "memory-user",
          conversationId: "memory-conversation",
          title: "Live contract",
        },
      });
      const results = await memory.searchSimilar("Couchbase", {
        limit: 1,
        filter: { userId: "memory-user", conversationId: "memory-conversation" },
      });

      expect(results).toEqual([
        expect.objectContaining({
          id: "memory-contract",
          content: "Couchbase live VoltAgent contract verification.",
        }),
      ]);
    } finally {
      await memory.removeDocument("memory-contract");
    }
  });

  it("executes real KV get, update, delete, count, and safe clear operations", async () => {
    await adapter.store("temporary", [0.5, 0.5], { userId: "u1" });
    await expect(adapter.get("temporary")).resolves.toMatchObject({ id: "temporary" });
    await adapter.delete("temporary");
    await expect(adapter.get("temporary")).resolves.toBeNull();

    const collection = await adapter.getCollection();
    await collection.upsert("voltagent::vector::application-document", {
      documentType: "invoice",
      amount: 42,
    });
    expect(await adapter.count()).toBe(3);
    await adapter.clear();
    expect(await adapter.count()).toBe(0);
    await expect(collection.get("voltagent::vector::application-document")).resolves.toMatchObject({
      content: { documentType: "invoice", amount: 42 },
    });
    await collection.remove("voltagent::vector::application-document");
    await expect(collection.get("voltagent::vector::application-document")).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });
});
