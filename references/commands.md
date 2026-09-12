# Command examples

In PowerShell, set `$wa` to the absolute installed `scripts/wa.mjs` path, then run:

```powershell
node $wa open
node $wa status
node $wa chats --query 'Team'
node $wa chat --name 'Team chat'
node $wa messages --chat 'Team chat' --older 3 --limit 100
node $wa links --chat 'Team chat'
node $wa download --chat 'Team chat' --message 'ID_FROM_MESSAGES' --item 0 --out 'C:/Project/input'
```

`open` starts in the background and reuses an existing session without changing its mode. `status` includes `headed:false` when no desktop window is shown. After linking in setup, run `close` then `open` for background use. To inspect manually, finish pending previews, run `close`, then `open --headed`. Both modes use the same login. A mode change restarts Chrome and can discard an unsent attachment preview.

`--older` is bounded (0–50). Repeated calls continue from the current scroll position. Dates displayed by WhatsApp can be locale-dependent; do not reinterpret them without context. Photos/documents without full date metadata return the available time only. No command guarantees complete history. A grouped album may require UI inspection to reveal additional items. View-once/disappearing or unavailable media may not be downloadable.

For text, first write exactly the desired content to a UTF-8 file using a file tool. Passing a file avoids PowerShell expansion of quotes, dollar signs and backticks.

```powershell
node $wa compose --chat 'Team chat' --text-file 'C:/Project/work/message.txt'
node $wa ui snapshot
# Only when the user has requested this exact send:
node $wa send --chat 'Team chat' --authorized
```

For a separate document send, start from an empty composer:

```powershell
node $wa upload --chat 'Team chat' --file 'C:/Project/output/report.pdf'
node $wa ui snapshot
# Only when the user has requested sending this file:
node $wa send --chat 'Team chat' --authorized
```

Compose and upload each require an empty normal composer. Send or deliberately clear an existing draft before starting another. Document upload preserves the original file and checks complete preview filenames. It prepares files without captions; any added caption must be cleared before upload verification or guarded send. Photos-as-media, captions, replies, reactions and other workflows can use the general UI commands where available, with explicit authorization for the full content.

```powershell
node $wa ui snapshot
node $wa ui click e42 --chat 'Team chat'
node $wa ui fill e43 --chat 'Team chat' --text-file 'C:/Project/work/text.txt'
node $wa ui press Escape --chat 'Team chat'
node $wa ui upload --chat 'Team chat' --file 'C:/Project/output/report.pdf'
node $wa ui scroll 0 -800 --chat 'Team chat'
node $wa ui screenshot --chat 'Team chat' --out 'C:/Project/work/whatsapp.png'
node $wa ui tabs
node $wa ui tab 0
```

Use a fresh snapshot for references. `ui upload` can complete a guarded file chooser or start ordinary document staging. `ui click` and `ui press Enter` are capable of sending; a generic command is not an authorization bypass. After visiting external links, `open` reselects an existing WhatsApp tab; `ui tabs`/`ui tab` provide explicit tab selection.

Useful errors: `SESSION_CLOSED` → open; `LOGIN_REQUIRED` → inspect loading/login; `WRONG_CHAT` → reverify and select; `AMBIGUOUS_CHAT` → clarify identity; `MESSAGE_NOT_LOADED` → scroll/read; `EXISTING_DRAFT`/`EXISTING_PREVIEW`/`DRAFT_CHANGED` → inspect the prepared content; `DRAFT_NOT_PREPARED`/`STATE_INVALID` → inspect and deliberately prepare with compose/upload; `BUSY` → another command owns the session or its lock needs inspection; `DOWNLOAD_UNCONFIRMED`/`SEND_UNCERTAIN` → inspect the actual outcome before any retry.

After `SEND_UNCERTAIN`, run `node $wa send-check --chat 'Team chat'`. This only reads matching outgoing content after the recorded latest chat position and clears the attempt if confirmed. It never clicks Send. Loading an older matching message cannot confirm the attempt. `send_unresolved` means the available evidence is insufficient: the recorded position may no longer be loaded, the attempt may have been recorded by a version without this evidence, or the chat may have had no readable messages before sending. Return to the latest messages and inspect the UI/history as needed. `status` includes a pending attempt timestamp. Do not prepare another copy as an automatic retry.

While an attempt is unresolved, compose and upload are blocked across all chats. After actually inspecting the UI/history, record a manual conclusion with `node $wa send-resolve --chat 'Team chat' --outcome sent --inspected` (or `not-sent` if inspection establishes that). It writes a private receipt and clears preparation without browser access. It does not claim automated delivery verification, change the visible draft or authorize another send. Never resolve uncertainty just to get past the guard.

Uploads stage only the selected files in private session storage so the browser backend can access them from any project. Colliding basenames receive unique names. If the file chooser or preview was left open by an interrupted upload, rerun the same `upload` command to verify/recover it. The source and staging hashes, paths and chat must still match. General `ui upload` can finish a chooser opened through a guarded `ui click` in the previous two minutes.

Browser internals are encapsulated in the adapter. The supported account is the one manually linked to the local Chrome profile; credentials are never exported. This is UI automation and may require selector updates after WhatsApp changes its interface.
