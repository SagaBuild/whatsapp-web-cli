# Contributing

Use Node.js 22+ and Google Chrome. Run `npm ci --ignore-scripts`, `npm test` and `npm run release:check`. No real WhatsApp login is needed for tests.

`npm run verify` runs the full synthetic suite and prints a shareable platform/architecture summary. CI covers Node 22/24 on Windows, Linux, Apple Silicon (`macos-15`) and Intel Mac (`macos-15-intel`), using the [official runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). A configured CI matrix is not evidence that a native run has passed; preserve that distinction in compatibility claims. Mac setup and verification are documented in the [macOS guide](docs/macos.md).

Tests use synthetic browser data in ignored `.work/` or short operating-system temporary directories and isolated CLI registries/profiles. Never point tests at a personal `WA_DATA_DIR`. CI must not contain account secrets or upload browser snapshots, traces or profiles. The [testing guide](docs/testing.md) explains the guarantees and limitations of each test layer and how to demonstrate a regression fails before the fix.

Reproduce selector bugs with small synthetic DOM fixtures. Preserve recipient checks, original download bytes, preparation/send separation and persistent login. Do not add internal WhatsApp-store APIs, credential extraction or retries after uncertain sends.

Distinguish fixture results from manual real-UI validation. If a live check is necessary, use your own account and an explicitly authorized self chat; do not commit those artifacts.

Add new source files to `release-files.json`. Files needed by the installed skill also belong in `runtime-files.json`. Stage only the reviewed inventory files before running the release check; it checks that the index and working copy agree. Inspect examples and prose for personal information before sharing. See [SECURITY.md](SECURITY.md) for vulnerability reporting. Contributions use the project's MIT license.
