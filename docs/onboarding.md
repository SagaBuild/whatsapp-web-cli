# Setup, login and recovery

## First run

Run `npm ci --ignore-scripts`, then `npm run setup` from the repository. Setup checks Node and Chrome, installs the skill and opens WhatsApp Web in its dedicated profile. Complete linking on your phone; the QR stays in WhatsApp's own Chrome window. Never upload it or your profile to an issue or an agent prompt.

For Apple Silicon and Intel Macs, see the [macOS guide](macos.md). The same Node installer works without PowerShell and retains the Mac's own linked profile.

Fresh installs use `~/.agents/skills/whatsapp-web`, following [Codex's user skill discovery location](https://learn.chatgpt.com/docs/build-skills). An explicitly set `CODEX_HOME` uses its `skills/whatsapp-web` directory. Existing managed installations, including older `.codex/skills/whatsapp-web` copies, are updated in place to avoid duplicate discovery.

```sh
npm run setup -- --timeout 300
npm run setup -- --skip-login
node scripts/setup.mjs --skip-install
node scripts/install.mjs --destination /absolute/path/to/skills/whatsapp-web
```

`--timeout` is the linking wait in seconds (default 180). If it expires, Chrome and the profile stay available; finish linking and rerun setup. `--skip-login` installs without opening WhatsApp. `--skip-install` uses the current copy. `--json` provides one structured final result; progress goes to stderr. Pending login exits with 2, errors with 1 and interruption with 130.

If the skill does not appear, restart Codex. The installed absolute CLI path printed by setup also works directly.

## Reuse your login

Normal use starts with `open` and `status`. Keep the default `whatsapp-codex` session across projects. The checkout, installed skill and other working directories share its stable runtime directory. `close` retains the profile. Setup never clears storage or logs you out.

`open` starts Chrome in the background without a desktop window. A running browser keeps its existing mode so repeated commands do not interrupt drafts or previews. `status` reports `headed:false` for background mode and `headed:true` for a visible window.

After first-time linking, close the login window through the CLI. The next open reuses its login in the background:

```sh
node scripts/wa.mjs close
node scripts/wa.mjs open
```

For a visible window, finish or deliberately discard any pending attachment preview, then run `close` followed by `open --headed`. Switching modes restarts Chrome and can discard unsent attachment previews; it does not clear the saved account. Setup retains an authenticated background session without opening a window. If that session needs linking, setup reopens the same profile visibly so you can scan the official QR code.

| Platform | Private data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%/codex-whatsapp-web` |
| macOS | `~/Library/Application Support/codex-whatsapp-web` |
| Linux | `$XDG_DATA_HOME/codex-whatsapp-web` or `~/.local/share/codex-whatsapp-web` |

`WA_DATA_DIR` overrides that directory and must be absolute. Changing it or selecting a new `--session` uses a different profile and may require linking again. Do not change either to fix ordinary loading errors. Do not put account data in a repository, shared profile, cloud-sync folder or CI secret.

## Recovery

| Result | Next step |
| --- | --- |
| `NODE_VERSION` | Install Node.js 22+ and restart the terminal. |
| `CHROME_MISSING` | Install desktop Google Chrome and rerun setup. |
| `CHROME_PATH` | Set `WA_CHROME_PATH` to an absolute Chrome executable or macOS `.app` path, or remove it to use automatic discovery. |
| `CLI_MISSING` | Run `npm ci --ignore-scripts` in the relevant source/skill directory. |
| `login_pending` | Finish linking in the open Chrome window, then rerun setup. |
| `loading` | Let WhatsApp load and check your connection; retain the profile. |
| `SESSION_CLOSED` | Run `open`. |
| `BROWSER_MODE` | Finish pending previews, then run `close` and `open --headed` to show a window. |
| `BUSY` | Let the other command finish; inspect a stale lock before changing it. |
| `FILE_CHOOSER_PENDING` | Complete or cancel the existing chooser. |
| `PROFILE_MISMATCH` | Inspect the session configuration; do not delete another profile. |
| `UNMANAGED_INSTALL` | Choose another destination or inspect the existing directory. |

If WhatsApp explicitly shows a login screen again, check **Linked devices** on your phone and relink this same profile if needed. WhatsApp can revoke linked devices, so permanent authentication cannot be guaranteed. [Official linked-device guidance](https://faq.whatsapp.com/1428782138011916/?cms_platform=web) covers checking and unlinking devices.

## Update or remove

Update the source, run `npm ci --ignore-scripts`, then `npm run setup`. Code is copied from an explicit inventory. Changed browser dependencies cause the managed browser to close before updating; account storage is retained. Ordinary code updates reuse existing dependencies.

Removing the installed skill does not revoke the linked device or delete account data. Revoke the device separately through WhatsApp's **Linked devices** screen. Remove private local data only when you intend to discard that login and history cache.
