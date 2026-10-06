# AGENTS.md

Notes for anyone, human or agent, changing this repository. The README is for users. This file covers how the repository is worked on and released. The details are in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) and [docs/RELEASING.md](docs/RELEASING.md).

## Layout

| Path | What it is |
| --- | --- |
| `src/`, `test/` | `@couchbase-ecosystem/voltagent` on npm: the VoltAgent `VectorAdapter` and `CouchbaseRetriever`, with unit and live tests |
| `docs/`, `examples/` | Tutorials, design notes and runnable examples. Both are shipped in the npm tarball (`files` in `package.json`), so keep them free of credentials |
| `scripts/` | Docker-based live Couchbase runners and the release-notes script |
| `.github/` | CI, live tests, PR labelling, draft release and publish workflows |

This is an npm-only package with `package-lock.json` and Node.js 22+. Don't switch package managers. Update the lockfile with npm 11 (`npx -y npm@11 install ...`); npm 10 drops the `libc` fields and churns the lockfile.

## Checks

```bash
npm ci
npm run check                     # lint, typecheck, test, build, publint
npm run test:coverage
npm pack --dry-run                # review the file list
npx attw --pack
npm run test:integration:docker   # live tests against a throwaway Couchbase Server 8 container
```

CI runs the same checks on Node.js 22, 24 and 26 (`ci.yml`), and the live tests in `live-integration.yml`. The design rules the adapter must keep are under "Implementation contracts" in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#implementation-contracts). Never commit `.env` files or credentials.

## Pull requests

- Use a conventional-commit title: `feat: …`, `fix: …`, `docs: …`, `test: …`, `ci: …`, `chore(deps): …`, `chore(release): …`. Mark breaking changes with `!` or a `BREAKING CHANGE:` footer.
- Release notes are generated from merged PR titles and grouped by label. `label-pull-requests.yml` adds the labels from the title and changed paths; check them before merging. The label table is in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#pull-request-labels). After fixing a label on a merged PR, run **Draft release** from the Actions tab to regenerate the draft.

## Releases

The full checklist is in [docs/RELEASING.md](docs/RELEASING.md). In short:

1. Every merge to `main` refreshes a draft GitHub release for the next version (`draft-release.yml`).
2. A maintainer opens a `chore(release): <version>` PR that bumps `package.json` and the lockfile and adds the `CHANGELOG.md` section.
3. After it merges, a maintainer pushes the tag `v<version>` on the merge commit. `publish.yml` checks the tag against `package.json` and npm, runs every check and the live tests, publishes to npm with provenance over OIDC from the `npm` environment, then publishes the draft release.

Agents may prepare release PRs (version bump, lockfile, changelog, docs). Pushing `v*` tags, publishing or editing GitHub releases, running `publish.yml` with `dry_run: false`, and anything on npmjs.com need explicit approval from a maintainer for that specific release. Ask before dispatching `publish.yml`, even as a dry run.

Things that break publishing if changed without updating the trusted publisher on npmjs.com: the workflow filename `publish.yml`, the `npm` environment name, and `repository.url` in `package.json` (provenance requires it to match this repository).
