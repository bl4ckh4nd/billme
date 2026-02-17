# Releasing

This repository uses GitHub Actions + Release Please to automate versioning, release notes, and desktop release publishing.

## Commit Convention

Use Conventional Commits on merge commits/PR titles:

- `fix: ...` -> patch release
- `feat: ...` -> minor release
- `feat!: ...` or `BREAKING CHANGE:` -> major release

## Automated Flow

1. Push/merge changes to `main`.
2. `.github/workflows/release-please.yml` runs and opens/updates a release PR.
3. The release PR bumps version in `apps/desktop/package.json` and updates `apps/desktop/CHANGELOG.md`.
4. Merge the release PR.
5. Release Please creates tag `vX.Y.Z`.
6. `.github/workflows/publish-release.yml` runs on the tag:
   - builds desktop distributables via electron-builder on Windows, macOS, and Linux
   - publishes/updates GitHub Release
   - attaches release files from all platforms
   - generates release notes automatically
   - can also be started manually via `workflow_dispatch` with a `tag` input

## Required Repository Secret

`release-please.yml` must use a token that can trigger downstream workflows.

- Add repository secret `RELEASE_PLEASE_TOKEN`.
- Recommended: classic PAT from a bot account with `repo` and `workflow` scopes.
- Why: tags/releases created with the default `GITHUB_TOKEN` do not trigger other workflows, so `Publish Release` would not start.

## CI And Build Verification

`.github/workflows/ci.yml` runs:

- on all pushes and pull requests:
  - desktop typecheck
  - desktop tests
  - desktop build
  - offer-portal build
- on push to `main` only:
  - desktop electron-builder distributable builds on Windows, macOS, and Linux
  - artifact upload for build outputs

## Troubleshooting

- If release build fails due native module rebuild issues, rerun the workflow after dependency cache refresh.
- If no release PR is opened, check commit messages follow Conventional Commits.
- If the GitHub Release exists without assets, run `Publish Release` manually and provide the tag (for example `v1.2.3`).
