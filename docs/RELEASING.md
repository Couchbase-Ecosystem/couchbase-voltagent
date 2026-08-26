# Releasing to npm

This is an npm-only integration. VoltAgent is a TypeScript/Node framework, so a PyPI package would
not implement its runtime contracts.

## Prerequisites

- Confirm the `Couchbase-Ecosystem/couchbase-voltagent` repository metadata in `package.json` still
  matches the public release location.
- Obtain publish access to the `@couchbase-ecosystem` npm organization and enable two-factor
  authentication on the maintainer account.
- Ensure the package name `@couchbase-ecosystem/voltagent` is approved for public use.
- Create a protected GitHub environment named `npm`, with the package maintainers as required
  reviewers.

## Bootstrap the package and trusted publisher

The npm package must exist before its trusted publisher can be configured. A maintainer with
`@couchbase-ecosystem` publish permission first sets and commits a bootstrap prerelease version such as
`0.1.0-rc.0`, pushes its commit and tag, and then performs this one-time publish from a clean
checkout:

```bash
npm login
npm ci
npm run check
npm run test:coverage
npm run test:integration:docker
npm pack --dry-run
npx attw --pack
npm publish --tag next --access public --provenance=false
```

Use a prerelease package version such as `0.1.0-rc.0` for this bootstrap; npm versions are immutable.
The explicit `--provenance=false` is limited to this local first publish because provenance requires
a supported CI identity. After the npm publish succeeds, create the matching GitHub prerelease using
the already-pushed `v0.1.0-rc.0` tag. The workflow detects that the immutable npm version already
exists and completes without attempting a duplicate publish, so the bootstrap version appears in
both npm and GitHub Releases.

After the package exists, open its npm **Settings → Trusted Publisher**, select GitHub Actions, and
configure these exact values:

- Organization or user: `Couchbase-Ecosystem`
- Repository: `couchbase-voltagent`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The checked-in [publish workflow](../.github/workflows/publish.yml) uses GitHub OIDC, so it requires
no `NPM_TOKEN`. It validates that the GitHub tag exactly matches `package.json`, publishes
prereleases to `next` and stable versions to `latest`, and leaves an already-published bootstrap
version untouched. Once one OIDC publish succeeds, set npm publishing access to **Require
two-factor authentication and disallow tokens**.

## Release checklist

1. Update `CHANGELOG.md` and the package version using semantic versioning.
2. Test the supported VoltAgent 2.x range. Test stable 3.x once available before widening the peer
   range.
3. Run:

   ```bash
   npm ci
   npm run check
   npm run test:coverage
   npm run test:integration:docker
   npm pack --dry-run
   npx attw --pack
   ```

4. Inspect dependency audit findings. Distinguish runtime issues from dev-only transitive findings;
   do not suppress either without a written decision.
5. Inspect the tarball contents and import both ESM and CommonJS exports.
6. After the bootstrap version, create the next release candidate:

   ```bash
   npm version prerelease --preid rc
   ```

7. Push the version commit and tag, then publish a GitHub release whose tag exactly matches
   `v<package.json version>`. Publishing the GitHub release triggers `publish.yml`; npm trusted
   publishing automatically creates provenance.
8. Install `@couchbase-ecosystem/voltagent@next` in a clean VoltAgent application and repeat a live query.
9. After review, set `0.1.0`, repeat the checklist, and publish GitHub release `v0.1.0`. Versions
   containing a prerelease suffix publish under npm's `next` tag; stable versions publish to
   `latest`.
10. Submit an upstream VoltAgent docs/example PR that links to the package.

Publishing, tags, GitHub releases, npm trusted-publisher configuration, and upstream PRs require
maintainer credentials and approval. Do not create a GitHub release until the npm environment and
trusted publisher are configured: a published release triggers the package workflow immediately.
