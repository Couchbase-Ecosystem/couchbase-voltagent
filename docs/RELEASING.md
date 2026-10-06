# Releasing to npm

This is an npm-only integration. VoltAgent is a TypeScript/Node framework, so a PyPI package would
not implement its runtime contracts.

Releases are published as [`@couchbase-ecosystem/voltagent`](https://www.npmjs.com/package/@couchbase-ecosystem/voltagent)
by `.github/workflows/publish.yml` with npm trusted publishing (OIDC) and provenance. No npm token is
stored in GitHub. The flow is the same as the TypeScript package in
[couchbase-strands-agents](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/typescript/RELEASING.md).

## How the pieces fit

| Piece | What it does |
| --- | --- |
| `.github/workflows/draft-release.yml` | On every push to `main`, regenerates a draft GitHub release for the next version. If `package.json` still holds a version that is already tagged, the draft is named after a placeholder (the next patch, or the stable version after a prerelease). Hand edits to the draft are overwritten on the next merge. |
| `scripts/release-notes.sh` | Builds the notes: GitHub's generated notes for the PRs merged since the previous `v*` tag. |
| `.github/release.yml` | Groups the notes by PR label (Features, Fixes, Testing and CI, …). PRs labelled `skip-changelog` are left out. |
| `.github/workflows/label-pull-requests.yml` | Labels PRs from their conventional-commit title and changed paths, so the notes stay grouped. The labels are listed in [CONTRIBUTING.md](CONTRIBUTING.md#pull-request-labels). |
| `.github/workflows/publish.yml` | On a `v*` tag: checks the tag matches `package.json` and that the version is not on npm yet, runs every check and the live Couchbase tests, publishes to npm with provenance, then publishes the draft GitHub release (or creates one if there is no draft). |

## Every release

1. Look at the draft release on the [Releases page](https://github.com/Couchbase-Ecosystem/couchbase-voltagent/releases)
   to see what has merged since the last release, and pick the next version (semver; anything that
   breaks the public API before 1.0 is a minor bump).
2. Test the supported VoltAgent 2.x range. Test stable 3.x once available before widening the peer
   range. Inspect `npm audit` findings, distinguishing runtime issues from dev-only transitive
   findings; do not suppress either without a written decision.
3. Open a release PR titled `chore(release): <version>` that:
   - sets `version` in `package.json` and updates the lockfile with `npm install --package-lock-only`;
   - adds a `## <version>` section to `CHANGELOG.md`.

   When it merges, the draft is renamed to `v<version>`.
4. Optionally edit the draft's wording. Do this after the release PR merges, because each merge
   regenerates the draft.
5. Tag the merge commit and push the tag:

   ```bash
   git switch main && git pull
   git tag v<version>
   git push origin v<version>
   ```

   The workflow fails if the tag and `package.json` disagree, or if the version is already on npm.
6. Watch the **Publish npm package** run. When it passes, the package is on npm with a provenance
   attestation and the GitHub release is published.
7. Check the result, then install the package in a clean VoltAgent application and repeat a live
   query:

   ```bash
   npm view @couchbase-ecosystem/voltagent@<version> dist.attestations
   gh release view v<version>
   ```

8. For the first stable release, submit an upstream VoltAgent docs/example PR that links to the
   package.

A version with a prerelease suffix (`0.2.0-rc.1`, for example from `npm version prerelease --preid rc
--no-git-tag-version`) is published under the `next` dist-tag and marked as a prerelease on GitHub,
so `npm install` keeps getting the latest stable version.

Do not publish a GitHub release by hand to start a release. Publishing no longer triggers
`publish.yml`; the tag push does, and the workflow publishes the release itself.

### Dry run

To rehearse without publishing, run **Publish npm package** manually from the Actions tab with
`tag: v<version>` and `dry_run: true` (the default). It runs every check, the live tests and
`npm publish --dry-run`, then stops. It does not touch the GitHub release.

### If something goes wrong

- **The workflow failed before `npm publish`.** Fix the problem on `main`. If the fix changes the
  released code, delete the tag (`git push origin :refs/tags/v<version>`), then tag the new commit
  and push again. Otherwise re-run the failed jobs.
- **npm publish succeeded but the GitHub release job failed.** Re-run only that job. It publishes
  the draft, or creates the release if there is no draft.
- **A bad version reached npm.** npm versions can't be reused. Deprecate it with
  `npm deprecate @couchbase-ecosystem/voltagent@<version> "<reason>"` and release a new patch. Use
  `npm unpublish` only within 72 hours, and only if nobody can depend on the version yet.

## npm and GitHub settings

These should stay this way:

- **Trusted publisher** on npmjs.com for `@couchbase-ecosystem/voltagent`: GitHub Actions,
  organization `Couchbase-Ecosystem`, repository `couchbase-voltagent`, workflow `publish.yml`,
  environment `npm`. Renaming the workflow file or the `npm` environment breaks publishing until
  this is updated. `repository.url` in `package.json` must keep matching this repository, because
  provenance requires it.
- **Publishing access**: "Require two-factor authentication and disallow tokens", so that only the
  workflow can publish.
- **GitHub environment** `npm`, with the package maintainers as required reviewers.

## History

`0.1.0` was published by hand on 2026-08-26, because npm only lets you add a trusted publisher to a
package that already exists. At the time `publish.yml` ran when a GitHub release was published, and
its run for `v0.1.0` failed at `npm publish`. Every later version is published from a `v*` tag by the
workflow.

Publishing, tags, GitHub releases, npm trusted-publisher configuration, and upstream PRs require
maintainer credentials and approval.
