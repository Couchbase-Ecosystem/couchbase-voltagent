# Contributing

## Local setup

```bash
npm ci
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

The script starts `couchbase/server:enterprise-8.0.2`, initializes Data/Query/Index services with
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

The lockfile is the source of truth for development tooling. The current compatibility baseline is
Node.js 22; CI also tests Node.js 24 LTS and Node.js 26 Current. `@types/node` intentionally tracks
the latest Node.js 22 declarations so type checking does not accidentally depend on APIs absent from
the minimum supported runtime. TypeScript 6.0.3 is the newest compiler compatible with tsup 8.5.1's
declaration bundler; TypeScript 7.0.2 type-checks the source but crashes that upstream bundler, so it
is intentionally not used. Before a release, use `npm outdated` and the official Couchbase Server
release notes to review dependency and Docker-image updates, then rerun every check above.
