# Contributing

## Local setup

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run publint
```

The project uses TypeScript, Biome, Vitest, and tsup. Unit tests mock the SDK boundary; the live suite
must exercise the adapter itself against Couchbase.

## Live Couchbase tests

Docker Engine is enough; Docker Compose is not required by the runner:

```bash
npm run test:integration:docker
```

The script starts `couchbase/server:enterprise-8.0.0`, initializes Data/Query/Index services with
Plasma, creates the `voltagent` bucket, runs the live tests, and removes only its named test
container. Do not point this command at a shared or production cluster.

The real-world customer-support documentation example has its own Docker smoke command:

```bash
npm run example:customer-support:docker
```

It must print `Verification: PASS`; the example throws when filtering or retrieval returns an
unexpected result.

To test an existing Server 8/Capella cluster instead:

```bash
CB_LIVE_TEST=1 \
CB_CONNECTION_STRING='couchbases://your-endpoint' \
CB_USERNAME='user' \
CB_PASSWORD='secret' \
CB_BUCKET='voltagent-test' \
npm run test:integration
```

The live test creates and drops a scope named `voltagent_test` in the configured bucket. Use a
disposable bucket and credentials with namespace/index-management permissions.

## Implementation contracts

- Target VoltAgent's public `VectorAdapter`; do not import private source paths.
- Keep Hyperscale (`CREATE VECTOR INDEX` plus `APPROX_VECTOR_DISTANCE`) as the default search path.
- Preserve caller IDs and exact dimensions.
- Reject unsupported filters rather than silently post-filtering an insufficient candidate set.
- Keep index provisioning explicit.
- Preserve the ownership boundary in every KV or bulk operation: prefix, discriminator, and CAS.
- Keep `clear()` and `count()` documented as low-concurrency maintenance operations; their KV range
  scans are deliberately chosen for safety and no-extra-index operation, not request-path scale.
- Batch methods may partially succeed, but must wait for all in-flight work before returning an
  error so callers never observe operations continuing after the promise settles.
- Avoid network calls at module import time.

## Package checks

Before release, run `npm run check`, `npm run test:coverage`,
`npm run test:integration:docker`, `npm pack --dry-run`, and `npx attw --pack`. Review the tarball list
for tests, secrets, environment files, or generated content that should not ship.
