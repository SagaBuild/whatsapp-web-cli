# Third-party dependencies

Project code is MIT licensed. Dependencies retain their own licenses and are installed from the lockfile; their code/binaries are not bundled in the source ZIP.

| Package | Version | License |
| --- | --- | --- |
| `@playwright/cli` | `0.1.19` | Apache-2.0 |
| `playwright` | `1.63.0-alpha-2026-08-31` | Apache-2.0 |
| `playwright-core` | `1.63.0-alpha-2026-08-31` | Apache-2.0 |

See [Microsoft Playwright CLI](https://github.com/microsoft/playwright-cli) and [Playwright](https://github.com/microsoft/playwright). Their packages retain applicable LICENSE, NOTICE and ThirdPartyNotices files. Preserve those notices when redistributing dependencies. The pre-release Playwright version is intentional: it is the tested dependency of the pinned CLI, and upgrades require regression tests.

The design was inspired by [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything). This project is independently implemented and does not bundle or depend on its code.

Chrome and WhatsApp are separately installed/accessed products governed by their providers' terms. Their names identify compatibility, not endorsement.
