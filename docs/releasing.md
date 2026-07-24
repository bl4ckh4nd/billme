# Releasing

This repository uses Release Please for the release tag and GitHub Actions for cross-platform Lite and
Pro desktop artifacts.

## Version ownership

`.release-please-config.json` links `apps/desktop` and `apps/pro-desktop` into one version group.
Release Please updates both package versions and changelogs together. Pro skips a separate GitHub
release because both applications are published by the same tag workflow.

## Commit convention

Use Conventional Commits on merge commits and PR titles:

- `fix: ...` -> patch release
- `feat: ...` -> minor release
- `feat!: ...` or `BREAKING CHANGE:` -> major release

## Automated flow

1. Push or merge changes to `main`.
2. `.github/workflows/release-please.yml` opens or updates the release PR.
3. Merge the release PR.
4. Release Please creates `vX.Y.Z`.
5. `.github/workflows/publish-release.yml` validates Lite and Pro, builds distributables, and publishes
   the GitHub release with generated notes and attached assets.

`publish-release.yml` can also be started manually with `workflow_dispatch` and an existing tag.

## Release build matrix and artifacts

The release workflow builds the Cartesian product of:

- `ubuntu-latest`, `macos-latest`, and `windows-latest`
- `apps/desktop` and `apps/pro-desktop`

Before packaging, its validation job runs Lite and Pro typechecks and tests. Each matrix job installs
the workspace without lifecycle scripts, rebuilds native dependencies for its selected app, then runs
the application build, `electron-builder`, and `scripts/verify-native-packaging.mjs`.

Both `apps/desktop/electron-builder.yml` and `apps/pro-desktop/electron-builder.yml` configure:

| Platform | electron-builder targets |
|---|---|
| Windows | NSIS |
| macOS | dmg, zip |
| Linux | AppImage, deb |

The workflow upload globs include `.rpm`, but neither electron-builder configuration declares an RPM
target, so the current release process does not produce RPM packages.

## Required repository secret

`.github/workflows/release-please.yml` passes `secrets.RELEASE_PLEASE_TOKEN` to Release Please. The
token must be able to create a tag that triggers the downstream `push.tags: v*` workflow; tags created
with the default `GITHUB_TOKEN` do not trigger that workflow.

## CI versus release packaging

`.github/workflows/ci.yml` runs on matching pushes and pull requests. Its `validate` job runs:

- Lite desktop typecheck, tests, `test:einvoice`, and build
- Pro desktop typecheck, tests, `test:einvoice`, and build
- offer-portal build
- Playwright desktop smoke tests for Lite and Pro

A separate `e2e-server-smoke` job installs Playwright Chromium, runs
`pnpm test:e2e:server:smoke`, and uploads the Playwright report and server-mode diagnostics.

CI does not run electron-builder or create desktop distributables. Normal distributable builds happen
only in `publish-release.yml` for a `v*` tag; the manual dispatch is the recovery path.

## Troubleshooting

- If a release build fails during native dependency packaging, rerun `Publish Release` for the same tag.
- If no release PR appears, verify that commits follow Conventional Commits and that
  `RELEASE_PLEASE_TOKEN` is configured.
- If a GitHub release has no assets, run `Publish Release` manually and provide the tag, for example
  `v1.2.3`.
