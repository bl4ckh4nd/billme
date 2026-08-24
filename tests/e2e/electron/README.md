# Electron PGlite smoke gate

`packaged-smoke.mjs` is the final local-runtime gate for both desktop products.
It intentionally exercises the public renderer API and does not open a database
file from the test process.

Run it from the repository root:

```bash
xvfb-run -a pnpm test:e2e:electron:packaged
```

The gate performs the following sequence for Lite and Pro:

1. Build the renderer, main process, and preload bundle.
2. Create a Linux-unpacked Electron application with `electron-builder`.
3. Verify that PGlite resources and server migrations are packaged, keytar has
   its native binary, and `better-sqlite3` is absent from the runtime bundle.
4. Launch the actual unpacked executable with a fresh temporary user profile.
5. Wait until the embedded API answers a public `clients:list` request.
6. Write a client through the typed `billmeApi` bridge and read it back.
7. Create a real `.pglite.tar` through typed `db:backup`, close the app, and
   reopen the same profile to prove persistence.
8. Add a second client, restore the archive through typed `db:restore`, wait for
   the controlled application exit, and verify after restart that only the
   archived state remains.

The development-profile suite covers the same lifecycle without packaging and
is useful for fast iteration:

```bash
E2E_FULL=1 pnpm exec playwright test \
  tests/e2e/desktop/pglite-persistence.spec.mjs \
  --project=desktop-full --workers=1
```

Both suites use an isolated temporary profile. A failed run must not reuse its
profile or infer persistence from a previous invocation. The CI job runs the
packaged gate under Xvfb after the Lite and Pro desktop builds.

If Electron reports that its binary is missing, first run a clean frozen
install. The root `pnpm.onlyBuiltDependencies` allowlist permits Electron,
keytar, and better-sqlite3 lifecycle scripts; the smoke gate is not a substitute
for repairing a partially populated `node_modules` directory.

The gate is deliberately fail-closed: a missing migration bundle, forbidden
SQLite runtime asset, unavailable renderer bridge, or failed public request
stops the run. A green builder invocation alone is not evidence that the
packaged application can start or preserve data.

The smoke output identifies each product separately, so a Lite pass never
masks a Pro packaging or launch failure.

It leaves no profile or archive behind after a successful or failed run.

Archive verification uses file metadata only; database internals remain behind
the application boundary.
