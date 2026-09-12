# Data and privacy

The project has no project-operated backend, analytics collector or public message relay. It controls the official WhatsApp Web UI in local Chrome. WhatsApp, Chrome, dependency installation and an AI agent each have their own networking and data policies.

## Local storage

The private application-data directory contains the linked Chrome profile, browser runtime, temporary UI snapshots, selected upload staging copies, drafts, send attempts and manual-resolution receipts. These are not all erased after each command: login reuse and interruption recovery depend on retaining state. Completed command files are removed; timed-out files may remain for inspection. Profile isolation is per operating-system user, not an extra encryption feature supplied by this project.

Downloads go to the requested directory. Their `wa-manifest.json` receipts include chat/message identifiers, available timestamps, filenames, sizes and hashes. Screenshots and UI snapshots can reveal conversations. Treat those artifacts as private even when they contain no passwords.

## Data leaving the device

- Chrome communicates with WhatsApp. Authorized messages and uploads go to the selected recipient.
- CLI results read by Codex or another agent enter its context. Its service settings govern further processing and retention.
- npm contacts package registries to install the pinned dependency when needed.

Setup prints linking instructions, readiness and local paths. It does not list/select chats, read messages, print QR contents or send a test message. Every user links their own account; no maintainer login is distributed.

## Sharing

`release-files.json` enumerates source-release files. `runtime-files.json` controls installed files. Git ignore rules and package allowlists provide additional protection. Release checks catch common private artifacts and unexpected tracked paths; they cannot prove that arbitrary prose contains no private information.

Never publish profiles, cookies, browser storage, QR/login codes, receipts, chat exports, real screenshots or raw logs from private chats. Use synthetic messages and filenames in issues. See [SECURITY.md](../SECURITY.md).
