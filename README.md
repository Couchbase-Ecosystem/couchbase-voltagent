# Couchbase for VoltAgent

`@couchbase-ecosystem/voltagent` adds Couchbase-backed vector memory and retrieval to
[VoltAgent](https://voltagent.dev/). It implements VoltAgent's public `VectorAdapter` contract and
uses Couchbase Server 8.0+ Hyperscale Vector Search through SQL++.

Use it to:

- persist VoltAgent semantic-memory embeddings next to operational application data;
- build filtered RAG retrieval with Couchbase scopes and collections; or
- expose a Couchbase knowledge base as a VoltAgent retriever or tool.

It does not generate embeddings, replace VoltAgent's conversation `StorageAdapter`, or provide
full-text/hybrid Search Service queries. Bring a VoltAgent embedding model or your own embedding
function. Hyperscale Vector Search is the default and only search backend in this first release.

## Requirements

- Node.js 22 or newer. CI covers maintained Node.js 22 and 24 LTS releases plus Node.js 26
  Current.
- `@voltagent/core` 2.4 or newer in the 2.x release line (verified with 2.11.0).
- Couchbase Server 8.0+ or a current Capella Operational cluster with Data, Query, and Index
  services. The Docker verification uses Couchbase Server 8.0.2.
- A COSINE Hyperscale vector index whose dimension matches the embedding model.
- Enterprise self-managed clusters must use standard GSI (Plasma) storage for vector indexes.

## Install

```bash
npm install @couchbase-ecosystem/voltagent @voltagent/core
```

## Quickstart

Create a bucket, scope, and dedicated collection first. The examples use
`app.application.voltagent_vectors`.

```ts
import { CouchbaseVectorAdapter } from "@couchbase-ecosystem/voltagent";

const vectors = new CouchbaseVectorAdapter({
  connectionString: process.env.CB_CONNECTION_STRING!,
  username: process.env.CB_USERNAME!,
  password: process.env.CB_PASSWORD!,
  bucketName: "app",
  scopeName: "application",
  collectionName: "voltagent_vectors",
  dimensions: 1536,
});

// Placeholder embeddings; replace with a real embedding model's output.
const embedding = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 1));
const queryEmbedding = embedding;

await vectors.storeBatch([
  {
    id: "doc-1",
    vector: embedding,
    content: "Couchbase stores operational and vector data together.",
    metadata: { userId: "user-1", conversationId: "conversation-1" },
  },
]);

// Provision once, using credentials with Query Manage Index. Keep this out of app startup.
await vectors.createHyperscaleVectorIndex();

const matches = await vectors.search(queryEmbedding, {
  limit: 5,
  threshold: 0.7,
  filter: { userId: "user-1", conversationId: "conversation-1" },
});

console.log(matches.map(({ id, score, content }) => ({ id, score, content })));
await vectors.close();
```

The generated index uses `COSINE`, `IVF,SQ8`, the document ownership predicate, and the default
prefilter fields `userId` and `conversationId`. For a production data set, load representative
vectors before the initial index build; rebuild the index if the vector distribution later changes
substantially. In production, run index creation as a deployment/provisioning step with a separate
privileged credential; do not grant Query Manage Index to the application runtime.

### VoltAgent semantic memory

Give an `Agent` a `Memory` with this adapter as `vector`, and VoltAgent embeds each message and
recalls similar earlier messages before the model is called. This example uses OpenAI models
through VoltAgent's model strings, so set `OPENAI_API_KEY`. It reuses the Quickstart collection and
index; `text-embedding-3-small` returns 1536-dimensional vectors.

```ts
import { Agent, InMemoryStorageAdapter, Memory } from "@voltagent/core";
import { CouchbaseVectorAdapter } from "@couchbase-ecosystem/voltagent";

const vector = new CouchbaseVectorAdapter({
  connectionString: process.env.CB_CONNECTION_STRING!,
  username: process.env.CB_USERNAME!,
  password: process.env.CB_PASSWORD!,
  bucketName: "app",
  scopeName: "application",
  collectionName: "voltagent_vectors",
  dimensions: 1536,
});

const memory = new Memory({
  storage: new InMemoryStorageAdapter(), // replace with persistent conversation storage as needed
  embedding: { model: "openai/text-embedding-3-small" },
  vector,
});

const agent = new Agent({
  name: "assistant",
  instructions: "You are a helpful assistant. Answer in one sentence.",
  model: "openai/gpt-4o-mini",
  memory,
});

const conversation = { userId: "user-2", conversationId: "conversation-2" };
await agent.generateText("My favorite database is Couchbase.", { memory: conversation });
const reply = await agent.generateText("Which database do I like?", { memory: conversation });

console.log(reply.text);
await vector.close();
// The agent's built-in VoltAgent observability keeps a timer running, so end the script explicitly.
process.exit(0);
```

VoltAgent automatically supplies `userId` and `conversationId` equality filters for semantic
memory. Those fields are included in the default Hyperscale index.

### Couchbase retriever

`CouchbaseRetriever` turns the same adapter into a VoltAgent `BaseRetriever`. Supply the embedding
function so the package remains provider-neutral. This example embeds with VoltAgent's
`AiSdkEmbeddingAdapter` and answers with an OpenAI model, so set `OPENAI_API_KEY`.

```ts
import { Agent, AiSdkEmbeddingAdapter } from "@voltagent/core";
import { CouchbaseVectorAdapter } from "@couchbase-ecosystem/voltagent";
import { CouchbaseRetriever } from "@couchbase-ecosystem/voltagent/retriever";

const embedding = new AiSdkEmbeddingAdapter("openai/text-embedding-3-small");

const vectors = new CouchbaseVectorAdapter({
  connectionString: process.env.CB_CONNECTION_STRING!,
  username: process.env.CB_USERNAME!,
  password: process.env.CB_PASSWORD!,
  bucketName: "app",
  scopeName: "application",
  collectionName: "voltagent_vectors",
  dimensions: 1536,
});

// Load the knowledge base. `content` is what the retriever hands to the model, and `title` is
// reported in the retrieval references.
const articles = [
  { id: "kb-returns", title: "Returns", content: "Unused items can be returned within 30 days." },
  { id: "kb-shipping", title: "Shipping", content: "Standard shipping takes 3 to 5 business days." },
];
const articleVectors = await embedding.embedBatch(articles.map((article) => article.content));
await vectors.storeBatch(
  articles.map((article, index) => ({
    id: article.id,
    vector: articleVectors[index],
    content: article.content,
    metadata: { userId: "user-1", title: article.title },
  })),
);

const retriever = new CouchbaseRetriever({
  adapter: vectors,
  embed: (text) => embedding.embed(text),
  topK: 3,
  threshold: 0.7,
  // Only search the calling user's documents. `userId` is a default index prefilter.
  filter: ({ userId }) => (userId ? { userId } : undefined),
});

// Call the retriever directly...
console.log(await retriever.retrieve("How long do I have to return an item?", { userId: "user-1" }));

// ...or give it to an agent, which retrieves before every call. Expose `retriever.tool` instead to
// let the model decide when to search.
const agent = new Agent({
  name: "support",
  instructions: "Answer customer questions using only the retrieved documents.",
  model: "openai/gpt-4o-mini",
  retriever,
});
const answer = await agent.generateText("How long does shipping take?", { userId: "user-1" });

console.log(answer.text);
await vectors.close();
// The agent's built-in VoltAgent observability keeps a timer running, so end the script explicitly.
process.exit(0);
```

## Provision Couchbase

### Capella (recommended for hosted applications)

1. Create a Capella Operational cluster with Query and Index services.
2. Create the bucket, scope, and `voltagent_vectors` collection.
3. Add the application's outbound IP address to Capella's allowed IP list.
4. Create database credentials scoped to the bucket/collection. Runtime access needs KV read/write
   and Query Select; index provisioning additionally needs Query Manage Index. Reading index state
   with `getHyperscaleVectorIndexStatus()` needs Query List Index (or Query Manage Index).
5. Copy the SDK connection string and use `couchbases://...` with TLS.

Capella is the default choice when VoltAgent runs in a hosted platform: a Couchbase instance bound
only to a developer laptop is not reachable from that platform.

### Self-managed/local

Run Couchbase Server Enterprise 8.0+, enable Data, Query, and Index services, select standard GSI
(Plasma) index storage, and create the namespace in the Web Console. The repository's
`npm run test:integration:docker` command is also an executable local provisioning example.

Use `couchbase://127.0.0.1` locally. Use `couchbases://` plus a trusted CA in production.

## Why a dedicated collection matters for `clear()`

VoltAgent defines `VectorAdapter.clear()` as “remove every vector owned by this adapter.” It must
not mean “delete every document in the Couchbase collection.” A collection may also contain orders,
users, invoices, or another application's vectors.

The recommended layout is a dedicated collection such as
`app.application.voltagent_vectors`. Calling `clear()` deletes the adapter's documents, never the
collection itself. This makes the ownership boundary obvious to operators and lets collection-level
RBAC protect the rest of the application.

The collection and discriminator solve different problems. The dedicated collection limits the
operational blast radius and makes RBAC, retention, and inspection straightforward. The document
discriminator tells the adapter which documents inside that collection it owns, so it does not have
to equate “present in this collection” with “safe to delete.” A unique discriminator is therefore
required even when a dedicated collection is used.

The adapter enforces this ownership boundary in depth, including when a shared collection is
unavoidable:

- document keys begin with `voltagent::vector::` by default;
- every owned document contains `documentType: "voltagent_vector"` and `schemaVersion: 1`;
- `clear()` prefix-scans candidate keys, checks the discriminator, and CAS-deletes only owned docs;
- `store()` refuses to overwrite a key occupied by a document without that discriminator; and
- the Hyperscale index is partial: `WHERE documentType = 'voltagent_vector'`.

Changing `keyPrefix` or `documentType` creates a different ownership namespace. Keep both stable for
the lifetime of stored data. Do not reuse both reserved markers for unrelated application records;
they are ownership identifiers, not a security secret.

`clear()` and `count()` use Couchbase KV prefix scans and materialize the matching scan results. They
are safe maintenance operations, but they are O(n) in the adapter-owned keyspace and are not meant
for a request hot path or frequent use on very large collections.

## Filters and index changes

Hyperscale prefilters must be declared when the index is built. The adapter accepts equality filters
only for `filterFields`; unknown fields and non-scalar values throw
`CouchbaseUnsupportedFilterError` instead of falling back to an incorrect or expensive query.

```ts
import { CouchbaseVectorAdapter } from "@couchbase-ecosystem/voltagent";

const vectors = new CouchbaseVectorAdapter({
  connectionString: process.env.CB_CONNECTION_STRING!,
  username: process.env.CB_USERNAME!,
  password: process.env.CB_PASSWORD!,
  bucketName: "app",
  scopeName: "application",
  collectionName: "voltagent_vectors",
  dimensions: 1024,
  filterFields: ["userId", "conversationId", "tenantId", "category"],
});
```

After changing `dimensions`, `filterFields`, `documentType`, or index algorithm settings, rebuild the
index before serving queries.

### Hyperscale tuning

The adapter covers the Query Service tuning controls used by Couchbase's Query vector integrations.
Index-build defaults can be changed during provisioning, here with the `vectors` adapter from the
Quickstart:

```ts
await vectors.createHyperscaleVectorIndex({
  description: "IVF,SQ8",
  scanNProbes: 4,
  trainList: 50_000,
  persistFullVector: true,
});
```

`scanNProbes` sets the index's default probe count, while constructor option `nProbes` overrides the
probe count in each `APPROX_VECTOR_DISTANCE` query. Constructor options `rerank` and `topNScan`
control query-time reranking and candidate scanning. Reranking requires `persistFullVector`; the
adapter rejects an explicitly incompatible configuration. More probes, a larger training sample,
and reranking can improve recall at a latency, throughput, memory, or build-time cost, so benchmark
them with representative data rather than treating larger values as universally better.
`trainList` is the number of vectors sampled to train the index, and it cannot exceed the number of
documents in the collection: index creation fails with `InvalidTrainListSize` otherwise.

The similarity metric remains `COSINE`: VoltAgent's `VectorAdapter` contract requires cosine
similarity and a normalized `0..1` score. Couchbase Query also supports DOT and Euclidean metrics,
but exposing them here would violate that framework contract. `ANN_DISTANCE` is an alias of the
`APPROX_VECTOR_DISTANCE` function used by this package.

## Connection ownership

Pass connection fields and `close()` will close the SDK cluster created by the adapter. Alternatively,
inject an existing `cluster`; it remains caller-owned. `getCluster()` and `getCollection()` expose
the native SDK objects for advanced operations without wrapping the full Couchbase SDK.

## Troubleshooting

- **No index available / index scan error:** create the Hyperscale index and wait until its state is
  `online`; verify dimension and `COSINE` match the query.
- **Vector indexes require standard GSI:** use Enterprise Edition with Plasma, not
  `memory_optimized` index storage.
- **Filter field is not configured:** add it to `filterFields`, then rebuild the index.
- **Collection not found:** create the configured scope and collection; the adapter intentionally
  does not create application namespaces at runtime.
- **Authentication/authorization failure:** separate runtime data/query roles from the privileged
  index-provisioning role.
- **TLS failure in Capella:** use the `couchbases://` connection string and current Capella CA trust.
- **Document collision:** use the dedicated collection or select a different stable `keyPrefix`.
- **Large `clear()` or `count()`:** run it as an administrative job during low traffic. These methods
  use KV range scans, which Couchbase recommends for low-concurrency, non-latency-critical work.
- **Offline `models.dev` warning in development:** importing the optional retriever also imports
  `@voltagent/core`, whose development-mode model registry may attempt a background refresh. The
  root adapter export does not make this request, and production-mode imports do not start the
  refresh. This is upstream VoltAgent behavior, not a Couchbase connection attempt.

For a complete walkthrough, see [docs/TUTORIAL.md](docs/TUTORIAL.md). A runnable online-store support
scenario is in [docs/CUSTOMER_SUPPORT_EXAMPLE.md](docs/CUSTOMER_SUPPORT_EXAMPLE.md). Contributor
commands and the release process are in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) and
[docs/RELEASING.md](docs/RELEASING.md).

## Current limitations

- Couchbase Server 8.0+/current Capella Operational is required because Hyperscale is the default.
- Filters are scalar equality predicates over fields configured before index creation.
- Index creation is explicit and needs elevated privileges.
- `clear()` and `count()` are prefix-scan maintenance operations, not constant-time operations.
- Batch writes/deletes are concurrent but non-transactional. If one item fails, completed items are
  not rolled back; the method waits for in-flight operations before rejecting, and callers may retry
  safely by ID.
- `CouchbaseVectorAdapter` provides vector memory; it is not a full VoltAgent conversation
  `StorageAdapter`.
- VoltAgent 2.x is tested directly. The 3.x peer range should be added only after its stable API is
  available and covered in CI.

## License

Apache-2.0
