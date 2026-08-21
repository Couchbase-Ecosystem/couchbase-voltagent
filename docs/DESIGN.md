# Design and feasibility record

## Decision

- Status: implementable with explicit platform limitations.
- Delivery: standalone Couchbase-owned npm package, followed by an upstream VoltAgent example/docs
  contribution.
- Package: `@couchbase/voltagent`; no PyPI artifact.
- Search backend: Couchbase Server 8.0+/Capella Operational Hyperscale Vector Search by default.

## Target contract and references

VoltAgent's public `VectorAdapter` requires store, batch store, search, delete, batch delete, clear,
count, and get. Its search contract uses COSINE similarity, a normalized `0..1` score, optional
distance, scalar equality metadata filters, and caller-owned embeddings. The closest official
examples are VoltAgent's PostgreSQL/LibSQL vector adapters and its Pinecone retriever example.

Pinecone's current VoltAgent material is an example, not a published `@voltagent/pinecone` provider.
No current VoltAgent Milvus provider package was found. A standalone Couchbase package is therefore
a substantive integration, not a wrapper duplicating an established upstream provider.

## Capability mapping

| Requirement | Couchbase decision |
| --- | --- |
| Connection/auth/TLS | Official Node.js SDK; caller config or injected `Cluster` |
| CRUD and caller IDs | KV insert/get/replace/remove with prefixed keys and CAS |
| Vector search | SQL++ `APPROX_VECTOR_DISTANCE` using a Hyperscale vector index |
| Similarity | COSINE; distance normalized to VoltAgent score with `1 - distance / 2` |
| Metadata filters | Hyperscale scalar `INCLUDE` fields; only configured equality fields accepted |
| Index management | Explicit DDL helper and readiness/status methods |
| Clear/count | KV prefix scan plus document ownership discriminator |
| Embeddings | Supplied by VoltAgent or caller; Couchbase does not generate them |
| Local verification | Enterprise Server 8 container with Plasma, Query, Index, and Data services |

## Safety boundary

A dedicated collection is recommended because `clear()` is a package lifecycle operation, not an
application-wide delete. The implementation also reserves a document-key prefix, stores an explicit
document type and schema version, verifies ownership before mutation, performs CAS deletes, and
creates a partial vector index over only owned documents. This supports shared collections safely
without making them the recommended topology. The collection limits operational blast radius; the
discriminator identifies ownership within that boundary. Neither replaces the other, and unrelated
records must not reuse both reserved ownership markers.

## Known limitations

- Server 8.0+/current Capella Operational and an online Hyperscale index are required.
- Enterprise self-managed vector indexes require standard GSI/Plasma.
- Filter fields must be declared before index creation.
- `clear()` and `count()` materialize KV prefix scans and are maintenance operations rather than a
  hyperscale request-path primitive.
- Batches are concurrent and non-transactional. An error does not roll back successful items, though
  the adapter waits for all in-flight workers before rejecting.
- Index codebooks should be trained on representative data and rebuilt after major distribution
  changes.
- The package is a vector adapter/retriever, not a full conversation `StorageAdapter`.
- VoltAgent 3 compatibility remains a release gate until its stable API can be tested.
