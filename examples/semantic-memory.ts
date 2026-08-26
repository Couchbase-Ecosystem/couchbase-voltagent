import { CouchbaseVectorAdapter } from "@couchbase-ecosystem/voltagent";
import { type EmbeddingAdapter, InMemoryStorageAdapter, Memory } from "@voltagent/core";

class TutorialEmbedding implements EmbeddingAdapter {
  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();
    const couchbase = normalized.includes("couchbase") || normalized.includes("database") ? 1 : 0.1;
    const agents = normalized.includes("agent") || normalized.includes("voltagent") ? 1 : 0.1;
    const magnitude = Math.hypot(couchbase, agents);
    return [couchbase / magnitude, agents / magnitude];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimensions(): number {
    return 2;
  }

  getModelName(): string {
    return "tutorial-local-embedding";
  }
}

const vector = new CouchbaseVectorAdapter({
  connectionString: process.env.CB_CONNECTION_STRING ?? "couchbase://127.0.0.1",
  username: process.env.CB_USERNAME ?? "Administrator",
  password: process.env.CB_PASSWORD ?? "password",
  bucketName: process.env.CB_BUCKET ?? "app",
  scopeName: process.env.CB_SCOPE ?? "application",
  collectionName: process.env.CB_COLLECTION ?? "voltagent_vectors",
  dimensions: 2,
});

const memory = new Memory({
  storage: new InMemoryStorageAdapter(),
  embedding: new TutorialEmbedding(),
  vector,
});

try {
  await memory.addDocument({
    id: "couchbase",
    content: "Couchbase combines operational JSON data and vector search.",
    metadata: { userId: "tutorial", conversationId: "docs", title: "Couchbase" },
  });
  await memory.addDocument({
    id: "voltagent",
    content: "VoltAgent is a TypeScript framework for building AI agents.",
    metadata: { userId: "tutorial", conversationId: "docs", title: "VoltAgent" },
  });
  await memory.addDocument({
    id: "cooking",
    content: "A cast-iron pan retains heat for cooking.",
    metadata: { userId: "tutorial", conversationId: "docs", title: "Cooking" },
  });

  await vector.createHyperscaleVectorIndex();
  const results = await memory.searchSimilar("Couchbase vector database", {
    limit: 3,
    filter: { userId: "tutorial", conversationId: "docs" },
  });

  for (const result of results) {
    console.log(result.id, result.score.toFixed(3), result.content ?? result.metadata?.content);
  }
} finally {
  await vector.close();
}
