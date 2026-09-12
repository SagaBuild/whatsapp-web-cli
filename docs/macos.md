# macOS setup

The compatibility target is **macOS 14 Sonoma or later**, on **Apple Silicon or Intel**, with Node.js 22+ and Google Chrome. This follows the [Playwright system requirements](https://playwright.dev/docs/intro#system-requirements). Use a normal desktop session for the first QR scan; subsequent CLI use runs Chrome in the background.

The installer, browser selection, filesystem identity and Unicode file handling have automated regression coverage. CI includes native `macos-15` (Apple Silicon) and `macos-15-intel` runners; see the [current results](https://github.com/SagaBuild/whatsapp-web-cli/actions/workflows/ci.yml). These use synthetic data rather than a linked WhatsApp account. Use the account-free check below to verify a particular Mac.

## Install and link

1. Install [Node.js](https://nodejs.org/) and [Google Chrome](https://www.google.com/chrome/). Open Chrome normally once to complete its own first-run setup.
2. Extract the source ZIP and open Terminal in the `whatsapp-web-cli` folder.
3. Run:

```sh
npm ci --ignore-scripts
npm run setup
```

No PowerShell, global npm package, `sudo`, Homebrew or Xcode installation is required by this setup. Existing Node installations from Homebrew, the official installer or nvm are supported. Chrome can live in `/Applications` or your own `~/Applications` folder.

In WhatsApp on your phone, choose **Settings/menu → Linked devices → Link a device** and scan the QR in the dedicated Chrome window. Once setup says **Ready**, close the login window through the CLI and start background use:

```sh
node scripts/wa.mjs close
node scripts/wa.mjs open
node scripts/wa.mjs status
```

Then ask Codex to use `$whatsapp-web`. Setup prints the installed CLI path if you prefer calling it directly. If Codex does not discover the skill immediately, restart Codex. Normal commands do not require Screen Recording or Accessibility access because they control Chrome through Playwright.

Each computer links its own profile once. Link the Mac separately; retain the existing Windows login. Do not copy a linked browser profile between computers or include it in the source package. WhatsApp can revoke a linked device and require linking again.

## Saved login and Chrome location

The Mac profile and private runtime are stored under:

```text
~/Library/Application Support/codex-whatsapp-web/
```

Always quote paths containing spaces. Keep this directory and the default session when changing projects or updating code. It is separate from the installed skill and your usual Chrome profile.

If Chrome is installed somewhere else, select its app bundle or exact executable before setup. For example:

```sh
export WA_CHROME_PATH="$HOME/Applications/Google Chrome.app"
npm run setup
```

An invalid explicit Chrome path stops with an error. The CLI launches the exact detected executable; it does not fall back to another browser. For ordinary use, omit the variable when Chrome is in either standard Applications folder.

## Verify without a WhatsApp account

From the extracted source folder, run:

```sh
npm run verify
```

This runs synthetic tests in isolated profiles, including browser startup/restart, original downloads, uploads, installation/reinstallation, directory aliases and Unicode filenames. It never logs into WhatsApp or uses your linked profile. A successful final JSON summary includes `ok:true`, `platform:"darwin"`, the architecture, Node version and test counts. That summary is suitable to share; it contains no account data or home-directory paths.

On failure, inspect `.work/verification.log` locally or run `npm test` for details. The test command belongs to the source checkout; use `node scripts/wa.mjs doctor` for a quick check in an installed skill.

For login timeout, background/visible mode switching, updates and uninstalling, see [onboarding and recovery](onboarding.md). See [privacy](privacy.md) before sharing diagnostics.
