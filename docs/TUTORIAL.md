# Tutorial: VoltAgent semantic search with Couchbase

This tutorial uses a tiny deterministic embedding function so it runs without an external AI API.
Replace it with the same production embedding model used by your application.

## 1. Prerequisites

- Node.js 22+
- Couchbase Server Enterprise 8.0+ with Data, Query, and Index services, or Capella Operational
- Standard GSI (Plasma) index storage on self-managed Enterprise
- A database user with KV read/write and Query Select
- A separate setup user with Query Manage Index; Query List Index is sufficient for status checks

Choose Capella when the application runs outside your local network. A localhost Couchbase Server
works for local development, but a hosted VoltAgent process cannot reach it.

## 2. Create the namespace

In Query Workbench, create a dedicated collection:

```sql
CREATE SCOPE `app`.`application` IF NOT EXISTS;
CREATE COLLECTION `app`.`application`.`voltagent_vectors` IF NOT EXISTS;
```

The dedicated collection limits the blast radius of bulk lifecycle operations. It is not the only
ownership check: every adapter document also has a reserved key prefix and
`documentType: "voltagent_vector"`. `clear()` scans only that prefix, reloads each candidate, checks
the discriminator, then performs a CAS delete. It never drops the collection or blindly deletes all
documents in it. Keep the prefix and discriminator stable, and do not assign both to unrelated
application records.

## 3. Install and configure

```bash
npm install @couchbase/voltagent @voltagent/core
```

```bash
export CB_CONNECTION_STRING='couchbase://127.0.0.1'
export CB_USERNAME='Administrator'
export CB_PASSWORD='password'
```

For Capella, use its `couchbases://` SDK connection string and a database credential. Never commit
these variables.

## 4. Run the example

From a clone of this repository, install the locked dependencies and run the checked-in example:

```bash
npm ci
npm run example:semantic-memory
```

In another project, copy [examples/semantic-memory.ts](../examples/semantic-memory.ts), then run:

```bash
npm install --save-dev tsx@4.23.12
npx tsx semantic-memory.ts
```

The example performs this sequence:

1. connects to `app.application.voltagent_vectors`;
2. stores three documents through VoltAgent `Memory`;
3. creates the default COSINE Hyperscale index with `IVF,SQ8`;
4. searches through VoltAgent's `memory.searchSimilar()` API; and
5. closes the adapter-owned SDK connection.

Expected output starts with the Couchbase document:

```text
couchbase 1.000 Couchbase combines operational JSON data and vector search.
```

Index training samples the current data. Production deployments should insert a representative
initial data set before creating the index and rebuild it when the distribution changes materially.

## 5. Use the adapter in agent memory

Pass the same adapter as `vector` in `new Memory({ storage, embedding, vector })`. VoltAgent embeds
messages in batches and searches with `userId` and `conversationId`; both fields are Hyperscale
prefilters by default.

The adapter does not replace `storage`. Choose a VoltAgent `StorageAdapter` for conversations,
messages, working memory, and workflow state.

## 6. Verify and troubleshoot

Check index state:

```ts
console.log(await vectors.getHyperscaleVectorIndexStatus());
```

A healthy result is `{ state: "online", online: true, ... }`.

Run index creation and status checks with setup credentials, then use the lower-privilege runtime
credential for application traffic. The tutorial combines them only to keep the runnable example
short.

- If the index cannot be created, verify Server 8.0+, Enterprise/Capella, Index Service, Plasma
  storage, and Query Manage Index permission.
- If search reports a dimension mismatch, recreate the adapter and index with the embedding model's
  exact dimensions.
- If a filter is rejected, add the field to `filterFields` and rebuild the index.
- If no recent writes appear, confirm the query uses the same collection and discriminator. Searches
  use request-plus consistency by default.
- If `clear()` appears to leave data behind, inspect its discriminator. It intentionally ignores
  every non-`voltagent_vector` document.
- Treat `clear()` and `count()` as administrative operations. They materialize a KV prefix scan and
  are not intended for latency-sensitive paths or frequent use over very large data sets.

Developers can run the repository's full local verification with:

```bash
npm run test:integration:docker
```
