# Changelog

## 0.1.1

No changes to the library code or its runtime dependencies. This release ships the updated
documentation and examples that are included in the npm package, and is the first version published
by the tag-driven `publish.yml` workflow with npm provenance.

- Make the README and example scripts complete and runnable, including the `process.exit` needed to
  end standalone scripts that use `@voltagent/core` observability (#5).
- Verify against `@voltagent/core` 2.11.0 and refresh the pinned dev dependencies (#1).
- Publish from a `v*` tag with npm trusted publishing, and keep a draft GitHub release with
  generated notes (#4, #6).

## 0.1.0

- Add the Couchbase Hyperscale implementation of VoltAgent's `VectorAdapter`.
- Add a provider-neutral `CouchbaseRetriever`.
- Add explicit index provisioning/status helpers, safe collection cleanup, tests, and tutorials.
