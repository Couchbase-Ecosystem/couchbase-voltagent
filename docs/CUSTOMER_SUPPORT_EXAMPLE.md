# Real-world example: customer-support knowledge retrieval

This example uses Couchbase as the vector knowledge base for a small online-store support
assistant. It stores three policy articles through VoltAgent `Memory`, creates the default
Hyperscale `IVF,SQ8` index, and asks:

> Can I return headphones I purchased 20 days ago?

The Couchbase retriever searches only English documents for the `store-eu` tenant and verifies that
the returns policy is the top result. The demo uses a deterministic local embedding so it needs no
OpenAI or other model-provider key; a production application would replace that class with its real
embedding model.

## Run it against Couchbase in Docker

Prerequisites are Node.js 20+, npm, Docker Engine, and free ports 8091–8096 and 11210.

From this repository, run:

```bash
npm install
npm run example:customer-support:docker
```

The command performs the entire live path:

1. starts `couchbase/server:enterprise-8.0.0` in a temporary named container;
2. enables Data, Query, and Index services with Plasma index storage;
3. creates the `voltagent` bucket;
4. builds the package and runs
   [`docs/examples/customer-support-rag.mjs`](examples/customer-support-rag.mjs);
5. creates the dedicated `support_demo.knowledge` collection and a COSINE Hyperscale index;
6. stores, filters, and retrieves real documents through VoltAgent and the Couchbase adapter; and
7. removes the Docker container, even when verification fails.

Expected output ends with:

```text
Question: Can I return headphones I purchased 20 days ago?
Top reference: Returns and refunds (returns-policy)
Retrieved context:
Document 1 (ID: returns-policy, Score: 1.0000):
Customers may return headphones and other purchases within 30 days for a full refund.
Verification: PASS
```

The script throws and exits non-zero if the filtered top result or retrieved policy text is wrong,
so this is an executable documentation test rather than an output-only sample.

## Run it against an existing cluster

Create a `voltagent` bucket first, then provide connection settings:

```bash
CB_CONNECTION_STRING='couchbases://your-endpoint' \
CB_USERNAME='setup-user' \
CB_PASSWORD='secret' \
CB_BUCKET='voltagent' \
npm run example:customer-support
```

Use Capella when the application must reach Couchbase over the public internet. The example creates
its scope, collection, and index, so its credential needs namespace management, KV read/write, Query
Select, and Query Manage Index permissions. This combination is only for a compact demo. In
production, provision the namespace and index separately, then run the application with a scoped
KV/Query credential.

The example leaves `support_demo.knowledge` in an existing cluster so it can be inspected and rerun.
Set `CB_CLEANUP=1` to drop the demo scope after the run. Never point cleanup at a scope that contains
application data.

## Why the collection and discriminator are both present

The dedicated `knowledge` collection limits the operational blast radius. The
`support_knowledge_chunk` discriminator and `support-demo::article::` key prefix identify the exact
documents owned by this adapter. This allows lifecycle methods such as `clear()` to distinguish
knowledge articles from unrelated documents instead of treating every collection document as safe
to delete.

## Common failures

- **Ports already allocated:** stop the service using 8091–8096 or 11210, then rerun the Docker
  command.
- **Index creation fails:** confirm Couchbase Server Enterprise 8.0+, Query and Index services, and
  standard GSI/Plasma storage.
- **Authorization failure:** use a setup credential for this demo; production runtime credentials
  should not receive namespace or index-management privileges.
- **Wrong result after modifying documents:** keep the same embedding dimensions and rebuild the
  Hyperscale index after material changes to the data distribution.
