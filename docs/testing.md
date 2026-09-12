# What the tests establish

Run `npm ci --ignore-scripts`, then `npm test`. Node.js 22+ and Google Chrome are required. No WhatsApp login is needed. `npm run verify` prints a shareable summary; inspect failures locally with `npm test`.

## Test boundaries

| Layer | Observable outcomes |
| --- | --- |
| CLI workflows | Real command exit codes and JSON; exact downloaded bytes, editor text and browser-selected file bytes; recovery before and after native file handoff. |
| Browser adapter | Chat changes, search filtering, history loading, limits, exact content and filenames, incoming versus outgoing rows, changed chats and one-click uncertainty. |
| Persistent transport | Real Chrome cookies, localStorage and IndexedDB across restarts; malformed results, lost responses, registration replacement and independent fixture cleanup. |
| Storage | Known SHA-256 values, equal-length corruption, exclusive filenames, manifest failure rollback and lock ownership. |
| Installer | Executable dependency health, failed updates, real offline npm fixtures, alias serialization, destination links and configured synthetic profile preservation. |
| Release checker | Otherwise-valid archives containing forbidden paths, synthetic credential canaries and directory links escaping the archive. |

Browser pages are deliberately authored synthetic fixtures. Some are served on loopback; the CLI workflow fixture intercepts every request and supplies a synthetic page for the WhatsApp origin before navigation. The real origin guard still runs, and unhandled network requests are blocked. Original downloads can use browser Blobs containing independently known bytes. These fixtures do not establish compatibility with every current WhatsApp UI variant, account state, language or server response. An observed outgoing bubble is not a server delivery receipt.

Tests allocate disposable profiles, registries and files in ignored `.work/` directories or short operating-system temporary directories. Short paths avoid Windows browser database path limits. Browser fixtures record their exact disposable processes and use the pinned backend independently of the transport under test for cleanup. Failed cleanup retains its private registry for inspection. Never upload these directories, traces or screenshots as CI artifacts.

## Adding a regression

1. Reproduce the reported behavior with a small fixture and an observable result. A download assertion should inspect bytes; a chat-selection assertion should start in a different chat.
2. Run the assertion against the broken behavior. For a missing guard, temporarily remove that guard in an isolated source copy and confirm the new assertion fails for the intended reason. A syntax error or fixture setup failure does not count.
3. Apply the fix and run the relevant tests, then the full suite. Preserve existing safety checks and avoid real-account data in test fixtures.

Mocks should reject unexpected commands and arguments. They may model a state transition, but should not manufacture an entire successful result regardless of the command. Use a real subprocess or browser at the boundary when that is what the guarantee concerns. Prefer independently known expectations over computing expected values with the same production helper.

Test counts, line coverage and a configured CI matrix are useful diagnostics, not proof of workflow correctness. Code serialized into another process can also make coverage instrumentation undercount real execution. Keep native CI results, synthetic fixture evidence and any separately authorized manual UI checks distinct.
