/*
 * Runnable customer-support retrieval example.
 *
 * This intentionally uses a tiny local embedding implementation so verification needs no AI API
 * key. Replace SupportEmbedding with your production EmbeddingAdapter in a real application.
 */
process.env.NODE_ENV ??= "production";

const [voltagent, couchbaseIntegration, couchbaseRetriever, couchbase] = await Promise.all([
  import("@voltagent/core"),
  import("@couchbase/voltagent"),
  import("@couchbase/voltagent/retriever"),
  import("couchbase"),
]);

const { InMemoryStorageAdapter, Memory } = voltagent;
const { CouchbaseVectorAdapter } = couchbaseIntegration;
const { CouchbaseRetriever } = couchbaseRetriever;
const { CollectionExistsError, ScopeExistsError } = couchbase;

class SupportEmbedding {
  async embed(text) {
    const normalized = text.toLowerCase();
    const vector = [
      countMatches(normalized, ["return", "refund", "headphone", "purchase"]),
      countMatches(normalized, ["ship", "delivery", "parcel", "order"]),
      countMatches(normalized, ["password", "login", "account", "reset"]),
    ];
    if (vector.every((value) => value === 0)) {
      return normalize([1, 1, 1]);
    }
    return normalize(vector);
  }

  async embedBatch(texts) {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimensions() {
    return 3;
  }

  getModelName() {
    return "customer-support-keyword-demo";
  }
}

function countMatches(text, terms) {
  return terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
}

function normalize(vector) {
  const magnitude = Math.hypot(...vector);
  return vector.map((value) => value / magnitude);
}

async function waitForCollection(collection) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await collection.upsert("support-demo::readiness", { ready: true });
      await collection.remove("support-demo::readiness");
      return;
    } catch (error) {
      if (attempt === 20) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

const bucketName = process.env.CB_BUCKET ?? "voltagent";
const scopeName = process.env.CB_SCOPE ?? "support_demo";
const collectionName = process.env.CB_COLLECTION ?? "knowledge";
const vector = new CouchbaseVectorAdapter({
  connectionString: process.env.CB_CONNECTION_STRING ?? "couchbase://127.0.0.1",
  username: process.env.CB_USERNAME ?? "Administrator",
  password: process.env.CB_PASSWORD ?? "password",
  bucketName,
  scopeName,
  collectionName,
  dimensions: 3,
  documentType: "support_knowledge_chunk",
  keyPrefix: "support-demo::article::",
  filterFields: ["tenantId", "locale"],
  indexName: "support_knowledge_hyperscale",
});

let scopeAvailable = false;
try {
  const cluster = await vector.getCluster();
  const collectionManager = cluster.bucket(bucketName).collections();
  try {
    await collectionManager.createScope(scopeName);
    scopeAvailable = true;
  } catch (error) {
    if (!(error instanceof ScopeExistsError)) {
      throw error;
    }
    scopeAvailable = true;
  }
  try {
    await collectionManager.createCollection(collectionName, scopeName);
  } catch (error) {
    if (!(error instanceof CollectionExistsError)) {
      throw error;
    }
  }

  await waitForCollection(await vector.getCollection());

  const embedding = new SupportEmbedding();
  const memory = new Memory({
    storage: new InMemoryStorageAdapter(),
    embedding,
    vector,
  });
  await Promise.all([
    memory.addDocument({
      id: "returns-policy",
      content:
        "Customers may return headphones and other purchases within 30 days for a full refund.",
      metadata: { tenantId: "store-eu", locale: "en", title: "Returns and refunds" },
    }),
    memory.addDocument({
      id: "shipping-policy",
      content: "Standard shipping delivers an order in three to five business days.",
      metadata: { tenantId: "store-eu", locale: "en", title: "Shipping times" },
    }),
    memory.addDocument({
      id: "account-help",
      content: "Reset a forgotten password from the account login page.",
      metadata: { tenantId: "store-eu", locale: "en", title: "Account access" },
    }),
  ]);

  // Provisioning is explicit. Production applications should run this with a separate setup user.
  await vector.createHyperscaleVectorIndex();

  const retriever = new CouchbaseRetriever({
    adapter: vector,
    embed: (text) => embedding.embed(text),
    topK: 1,
    threshold: 0.7,
    filter: { tenantId: "store-eu", locale: "en" },
    sourceName: "Support knowledge base",
  });
  const context = new Map();
  const question = "Can I return headphones I purchased 20 days ago?";
  const answer = await retriever.retrieve(question, { context });
  const references = context.get("references");

  if (!Array.isArray(references) || references[0]?.id !== "returns-policy") {
    throw new Error("Verification failed: the returns policy was not the top filtered result");
  }
  if (!answer.includes("within 30 days")) {
    throw new Error("Verification failed: retrieved content did not contain the expected policy");
  }

  console.log(`Question: ${question}`);
  console.log(`Top reference: ${references[0].title} (${references[0].id})`);
  console.log("Retrieved context:");
  console.log(answer);
  console.log("Verification: PASS");
} finally {
  try {
    if (process.env.CB_CLEANUP === "1" && scopeAvailable) {
      const cluster = await vector.getCluster();
      await cluster.bucket(bucketName).collections().dropScope(scopeName);
    }
  } finally {
    await vector.close();
  }
}
