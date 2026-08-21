# Releasing to npm

This is an npm-only integration. VoltAgent is a TypeScript/Node framework, so a PyPI package would
not implement its runtime contracts.

## Prerequisites

- Confirm the `Couchbase-Ecosystem/couchbase-voltagent` repository metadata in `package.json` still
  matches the public release location.
- Obtain publish access to the `@couchbase` npm organization.
- Use an npm trusted publisher (recommended) or an automation token with publish permission.
- Ensure the package name `@couchbase/voltagent` is approved for public use.

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
6. Publish a prerelease first:

   ```bash
   npm version prerelease --preid rc
   npm publish --tag next --provenance
   ```

7. Install `@couchbase/voltagent@next` in a clean VoltAgent application and repeat a live query.
8. Promote a reviewed stable version with `npm publish --provenance`.
9. Create the matching GitHub release and submit an upstream VoltAgent docs/example PR that links to
   the package.

Publishing, tags, GitHub releases, and upstream PRs require maintainer credentials and approval; the
repository itself does not perform those external actions.
