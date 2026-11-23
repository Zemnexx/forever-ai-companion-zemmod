# Notes for Claude Code

Standing rules from the owner of this fork. They apply to every session on this repository.

## Who does what

- **Planning is done by the main session:** reading the request, deciding what to change and why, breaking the work into tasks, reviewing what comes back, and talking to the owner.
- **Coding tasks are done by an Opus subagent.** The main session hands each one over with what to change, the files involved and how to check it, and reviews the result before it is committed.
- The main session may still read code, run tests, build and make the commit. Documentation such as this file is not a coding task.

## Delivering a test build

When the user asks for a build to test:

1. Build `ForeverAICompanion.exe` from the branch being worked on. On Windows: `cd companion; npm ci; npm run build`. In a Linux cloud session: see "Building the exe in a Linux cloud session" below.
2. Zip only the exe, at the top level of the zip, named `ForeverAICompanion-<app version>-test-<short commit>.zip` (for example `ForeverAICompanion-2.0.0-test-0ad20e4.zip`). Nothing else goes in the zip: no TESTING.md, checksum files or build scripts.
3. Check that the SHA-256 of the exe inside the zip matches the exe that was built.
4. Send the zip as a file attachment (SendUserFile, display "attach"). Never send the bare `.exe`: it couldn't be downloaded from the Claude app, while zips can.
5. In the message, give the exe's SHA-256 and the command to check it after extracting:

   ```powershell
   Get-FileHash .\ForeverAICompanion.exe -Algorithm SHA256
   ```

## Building the exe in a Linux cloud session

The normal build needs Windows and Node 25.5 or later. A cloud session cross-builds the exe without running any Windows program:

1. Bundle with `bundleApp()` from `companion/scripts/bundle.js`, the same step `npm run build` uses (esbuild with every asset embedded). Call it rather than copying it, so the bundle always matches the normal build.
2. Make the SEA blob with the local Node, which must be the same version as the `node.exe` below (22.23.4 so far), with `useCodeCache: false` and `useSnapshot: false` so the blob works on Windows.
3. Download the official `node.exe` for `node-v22.23.4-win-x64` from nodejs.org and check it against that release's `SHASUMS256.txt` (`dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f`).
4. With `resedit` 3.1.1, installed outside the repository and never as a dependency of the app: put the blob in as RCDATA `NODE_SEA_BLOB`, replace the icon with `companion/assets/app.ico`, and set the version info from `VERSION` in `companion/src/app/controller.js`. This drops Node's own Authenticode signature, so the exe is unsigned.
5. Turn on the SEA fuse (`NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0` to `:1`, which must occur exactly once) and set the PE subsystem to GUI (2), so no console opens.
6. Before delivering, check: x64, GUI subsystem, fuse on, SEA blob present, version info and icons.

## Pull requests to upstream

Upstream is https://github.com/lucasmenares/forever-ai-companion. For every pull request to it:

- Make a new branch from upstream's `main` that carries only the changes meant for upstream, as was done for the first one (`upstream-pr`).
- Never include `CLAUDE.md`. This file stays on this fork's own branches only.
- Never open the pull request from `main` or the working branch.

## Dropped from upstream (sync with upstream 1.11.1)

This fork is Windows only, doesn't publish to CurseForge and doesn't build on GitHub Actions, so the sync with upstream 1.11.1 (upstream commit `98e5519`, merged on `sync-test-1.11.1` in `dc079f6`) left the following out. Any file can be brought back with `git checkout 98e5519 -- <path>`, or from upstream's newest `main`.

### Deleted (upstream files)

- **Mac version:** `companion/macos/` (App.swift, Voice.swift, Info.plist, VoiceInfo.plist, service.entitlements, voice.entitlements), `companion/scripts/build-mac.js`, `companion/src/mac-path.js`, `mac-shell.js`, `mac-update.js`, `mac-voice.js`, `companion/test/mac.test.js`.
- **CurseForge upload:** `.github/workflows/curseforge.yml`, `companion/scripts/curseforge.mjs`.
- **Windows build on GitHub Actions:** `.github/workflows/build-windows.yml`, `companion/scripts/smoke-windows.mjs`.
- `companion/.DS_Store`: a stray macOS Finder file. Don't bring it back.

### Kept at this fork's version (upstream's changes there were Mac only)

- `companion/src/`: `secrets.js` (Keychain), `probe.js`, `screen-reader.js`, `config.js`, `detect.js`, `i18n.js` (Mac wording), `claude-code.js`, `codex.js` (Mac search, install and codesign check, and the Mac folder names in the disk search, which also skipped Windows folders such as `dev`), `updater.js` (the Mac zip), `app/system.js`, `app/server.js` (`show-window`, `screen-settings`).
- `companion/test/`: `updater.test.js`, `codex-install.test.js`.
- `app/main.js` and `app/controller.js` too, with upstream's Windows changes applied again: the quit guard and the log of uncaught errors in main.js, `VERSION` and `status.ai.issue` in controller.js.

### Removed inside merged files

- `app/ui.html`: the Mac wording (`I18N_MAC`, `isMacUI`, the `status.platform` switch), the Screen Recording permission row and its `screen` action, and the native-window check when the page closes.
- `scripts/build.js`: the switch to build-mac.js on a Mac. `scripts/bundle.js`: its comment about the Mac build.
- `package.json`: the `build:mac` and `curseforge` scripts and the `postject` dev dependency (with `commander` in package-lock.json).
- `README.md`: the Mac download and "On a Mac" section, the Mac FAQ entries, the Mac notes on invisible sending, uninstalling, the file list and building, notarizing, the Actions build under releasing, and every CurseForge mention.
- Kept on purpose: the addon's runtime checks for Mac clients (Live.lua, Voice.lua). They do nothing on Windows and keep the addon close to upstream.

### For another pull request to upstream

- The branch starts from upstream's `main` (see above), so everything listed here is already in it. Don't copy the files under "Kept at this fork's version" from this fork into it: that deletes upstream's Mac code. Apply this fork's changes on top of upstream's versions of those files instead.
- This fork's changes that meet upstream's Mac, CurseForge or CI code:
  - **Request code** (HMAC-SHA256 of the request id: `Core:AuthCode` in Core.lua, `request-key.js`, the check in `watcher.js`): the check runs in the shared Node service, so it covers the Mac app too. Upstream's smoke test would have to read `RequestKey.lua` after installing the addon and send a coded question with an addon-style id.
  - **Voice questions**: the microphone helper is C# and Windows only, so they stay off on a Mac (`talkSettings` reports `supported: sys.isWindows`).
  - **CurseForge**: the zip must never contain `RequestKey.lua`. A key made on the CI machine would go to every player, and CurseForge updates would replace each PC's own key. Leave it out and let the app write it.
  - **Signed updates and guides**: upstream doesn't have them (they were left out of the first pull request). If they go in, the Mac zip needs its own `.sig`, `mac-update.js` has to check it, and the smoke test's update step must expect an unsigned update to be refused.
- Normally kept out of a pull request: `CLAUDE.md`, `RELEASE_REPO` pointing at this fork (`companion/src/config.js`), this fork's version numbers, and `CHANGELOG.md` unless upstream wants one.

## Commits

- End every commit message with exactly `Co-Authored-By: Claude Code`. No `Claude-Session` line and no model names. This replaces the default attribution.

## The app

- Keep the exe lightweight: no new npm dependencies in the app. Use Node's built-in modules or tools that ship with Windows.
