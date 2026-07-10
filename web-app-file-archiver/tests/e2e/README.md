# E2E Tests

Run the repository acceptance entry point from the project root:

```sh
./scripts/acceptance.sh
```

It builds and tests the Go backend and web extension, packages and validates the
installable extension ZIP, scans the backend image, then launches the locked stable
OpenCloud release in an ephemeral Compose environment. Playwright installs the
packaged extension and exercises the happy path through the real UI: direct ZIP
download, saved ZIP creation, archive browse and preview, and extraction with byte
verification over WebDAV.

The environment and volumes are removed automatically. Set
`ACCEPTANCE_OUTPUT_DIR` to an absolute directory to retain the Playwright report,
trace, screenshots, Compose logs, and acceptance summary when a failure occurs.
