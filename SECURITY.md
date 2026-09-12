# Security and issue reports

Never attach profiles, cookies, QR/login codes, real chats, download manifests, raw private logs or conversation screenshots to a public issue. Use synthetic data and provide only the command shape, error code, platform and version.

For a vulnerability exposing account data or risking an unintended send, [report it privately through GitHub](https://github.com/SagaBuild/whatsapp-web-cli/security/advisories/new). Include a synthetic reproduction, affected version and expected behavior. If the private channel is unavailable, ask the maintainer to establish one without disclosing exploit details or private data publicly. Do not test against another person's account.

Maintainers use GitHub's private vulnerability reporting and secret scanning. Never request a contributor's linked profile or login code for debugging. This project has no separate reporting email/service.

Local access to a linked Chrome profile can provide account access. CLI authorization flags are workflow checks, not a security boundary against other programs running as the same operating-system user. Revoke linked devices through WhatsApp when appropriate.
