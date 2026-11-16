# Changelog

## Unreleased: compact answers

Addon **1.14.0**.

### Added

- **Compact answers** (off by default; Options > AddOns > Forever AI Companion, or `/ia compact`). Asking with the chat window closed (talk key, `/ia talk`, `/ia <question>`) no longer opens it.
  - A small, slightly see-through box shows "Listening...", then "Thinking...", then the answer with what was asked.
  - It goes away after 20 seconds (5 to 60, adjustable). Hovering keeps it up, and it stays at least 5 more seconds after the mouse leaves.
  - Item links in it work like in the chat. It can be dragged, and remembers where.
  - **Open in chat** opens the chat. The answer is in the chat as usual, with the floating button's unread badge.
  - An answer to a question asked in the window that arrives after the window was closed also goes to the box, instead of the notification card.
  - Problems (in combat, a question already being sent, no invisible sending) show in the box instead of the hidden window.
- The options page scrolls, so its three sections fit any screen.

### Changed

- **Dimming while moving defaults to 75% opacity and 1 s**, so the window stays readable on the move. Combat stays at 30% and 2 s.

## Unreleased: chat window dims while moving or in combat

Addon **1.13.1**.

### Added

- **The chat window dims while the character moves** (walking, running, riding, swimming) and returns to full a moment after stopping.
- **It also dims in combat**, and returns to full a moment after the fight ends. When the character is both moving and fighting, the lower opacity is used.
  - It stays fully visible while the mouse is over it, while typing in it, while asking by voice, and on flight paths.
  - Opening it while moving or in combat shows it fully until the character stops or the fight ends.
- **Settings page in Options > AddOns > Forever AI Companion**, also opened by a new gear button in the window and by `/ia options` (`/ia opciones`).
  - While moving: on/off, opacity 10 to 95%, delay before returning to full 0 to 10 s in 0.5 s steps.
  - In combat: the same three settings of its own.
  - Moving defaults to on, 75% and 1 s; combat to on, 30% and 2 s.
  - A changed opacity is previewed on the window for a moment.
  - Settings are saved for the whole account, and only the ones the player changes are saved, so a later default change reaches everyone who never changed that setting. Values the 1.12.0 to 1.13.0 test builds saved on their own (60% and 1 s for moving) are dropped once, so those installs use the current defaults; other choices are kept.

## Unreleased: voice questions

Addon **1.11.1**. App `VERSION` unchanged (1.9.0). No npm dependencies added; the bundled code grew by about 20 KB.

### Added

- **Voice questions.** Hold a talk key (Key Bindings > Forever AI Companion > Talk to your assistant), click **Talk** in the chat window, or type `/ia talk`, then say the question.
  - The addon sends a "listen" request with the character data through invisible sending, and the app records until the key is released or the player pauses (30 s at most).
  - The recording is transcribed with OpenAI's transcription API, using game names from the character data as hints.
  - The app answers it like a typed question, and the chat shows the words it heard.
  - Follow-up questions by voice continue the open chat.
- **Settings in the app window** ("Voice questions"): on/off (off by default), the OpenAI key (the ChatGPT key is reused when there is one, and a separate key is encrypted with DPAPI), the model, and a microphone test.
- **Microphone helper** (`mic/Mic.cs`), compiled on the PC like the tray icon. It keeps the microphone closed except while recording, plays a start and an end beep, and exits if the app goes away.

### Fixed

- **Key Bindings showed a dead "HEADER_FOREVERAICOMPANION" row** under "Other". The talk key now has its own "Forever AI Companion" section (a `category`, as Questie does, instead of a `header`). An existing binding is kept.

### Security

- **Request key.** The app writes a random key into the addon folder (`RequestKey.lua`), every request from the addon carries it, and the app ignores requests without it on every channel. This closes a gap where anything able to speak with the silent Windows voice, very likely including a web page using the browser's text-to-speech, could send the app questions. With voice questions it would also have been able to open the microphone. An addon loaded before the update is told to `/reload`.
- Audio is never written to disk. The key is never logged.

### Not yet verified on Windows

See `docs/voice-questions.md`: real microphone capture, the key-release binding in the client, timing and accuracy.

## Unreleased: security hardening

Based on app 1.9.0 and addon 1.10.3 (upstream commit `d85d47a`). Addon is now **1.10.4**. The app `VERSION` in `companion/src/app/controller.js` is still 1.9.0: set it before releasing.

This update addresses the seven findings of the v1.9.0 security review. No npm dependencies were added: everything uses Node's built-in `crypto` or tools that ship with Windows. The bundled code grew by about 15 KB.

### Security

- **Silent voice: elevated programs load an admin-only copy of the DLL** (finding 1). The machine-wide (HKLM) COM registration used to point at the DLL in `%LOCALAPPDATA%\Programs\ForeverAICompanion`, which any process running as the user could replace. The administrator step now:
  - copies the DLL to `%ProgramFiles%\ForeverAICompanion`;
  - sets an explicit ACL on that folder (Administrators and SYSTEM: full control; Users: read and execute; no inherited entries);
  - checks the copy's SHA-256 against the DLL the app just built;
  - points the HKLM `CodeBase` at that copy.

  The game, which is not elevated, keeps using the per-user registration, which the app updates without a prompt. The UAC step runs a short launcher that hashes the full script and runs exactly those bytes, so a change to the script file after it was written is refused.
- **Silent voice: only the app's own messages are kept** (finding 1). Any program can speak with the voice. The engine now hands over only request messages (`FAIC:` / `AZIA:`) and the addon's voice test. Any other text is dropped without being written to disk or logged. The engine also refuses to write or delete through a junction or symlink planted in its data folder. The app no longer logs text received from other programs.
- **Signed updates** (finding 2). A release is only offered if it carries `ForeverAICompanion.exe.sig`. The signature covers the file name, the release version, the size and the SHA-256, so it can't be reused for another file or to pass an old build off as a new version. A download that fails the check is deleted before anything runs it. Signatures are ECDSA P-256 / SHA-256 (ES256), checked against the public keys pinned in `TRUSTED_KEYS`. ES256 was chosen so the private key can stay inside Azure Key Vault.
- **Signed guide, fenced in the prompt** (finding 3). A downloaded WoW Forever guide is only used if `wow-forever.md.sig` verifies. This is checked when it is downloaded and again every time it is read from disk. The guide now reaches the AI inside `<forever-guide>` tags as reference data, with an instruction to ignore any instructions written inside it. Tags inside the guide text are removed so it can't close the fence.
- **Codex retry no longer fails open** (finding 4). Before, if Codex rejected any `--disable` flag, the app retried with every flag removed, which turned the shell tool back on. Now it only drops the feature Codex names. If that feature is one of the safety ones (`shell_tool`, `unified_exec`, `apps`, `plugins`, `browser_use`, `computer_use`, `view_image`, `hooks`), or the error names nothing the app sent, the question fails instead.
- **Codex: signer check before running a found or downloaded copy** (finding 5). The PC search and the in-app install only run a `codex.exe` whose Authenticode signature Windows reports as `Valid` with organization "OpenAI OpCo, LLC". That signer was confirmed on codex 0.169.0. Running processes are only considered if their file name is Codex's. `.cmd` launchers only run from npm/pnpm's usual locations, never from the disk search. Choosing a file by hand ("pick Codex") is unchanged.
- **API keys encrypted with DPAPI** (finding 6). Keys in `%APPDATA%\ForeverAICompanion\config.json` are stored as `{ "dpapi": "..." }`, encrypted for the current Windows user (CurrentUser scope, with app-specific entropy) through .NET's `ProtectedData`. Plain-text keys from earlier versions are encrypted the next time the app starts. If encryption fails, the key is not saved at all. Outside Windows (development) keys stay as plain text, as before.
- **The channel test watches the game's files only while it runs** (finding 7). Before, the probe monitor ran all the time, re-reading up to 2 MB of the chat log every time it changed. Now it is idle until the addon starts `/ia probe`, stops 15 minutes later (to catch files the game writes at logout), and reads only the part of the chat log added since its last check.

### Changes players will notice

- On PCs where invisible sending is on, the app offers **Update invisible sending** once: one UAC prompt, then restart WoW. Until then it keeps working as before.
- Updates and guide downloads stay off until a signing key is pinned in `TRUSTED_KEYS`. Without a key, the app uses the guide built into it and does not update itself.
- `/ia probe` now takes two steps. The addon first asks the app to start recording (the chat shows the app's "Recording" answer) and runs the probes only after that answer arrives. If the app doesn't answer within 60 seconds, the test doesn't run and the addon says so.
- If a future Codex stops accepting one of the safety switches, questions fail with a message asking to update the app or choose another AI.
- The Codex PC search skips copies that aren't signed by OpenAI and logs which ones it skipped.

### Compatibility and upgrade notes

- **API keys:** the move to encrypted keys is one-way. An older version of the app can't read encrypted keys, so after a downgrade the keys must be pasted again.
- **Guides from earlier versions:** a guide downloaded by an earlier version has no signature, so it is ignored and the built-in guide is used instead.
- **Mixed app and addon versions:** the channel test works with mismatched versions. A new app with an old addon reports "run the test again" on the first run. An old app with the new addon answers the start request as an ordinary question, and the test continues.
- **Update source:** updates and the guide now come from `RELEASE_REPO` in `companion/src/config.js`. It is currently set to `zemnexx/forever-ai-companion-zemmod`, which should be the repository whose maintainer holds the signing key.

### For maintainers

- New files:
  - `companion/src/signing.js`: signature checks and the `TRUSTED_KEYS` list.
  - `companion/src/secrets.js`: DPAPI encryption of API keys.
  - `companion/scripts/sign.js`: `keygen`, `pubkey`, `release`, `guide`, plus `digest` and `attach` for Azure Key Vault.
  - `companion/test/secrets.test.js`.
- Release process: after `npm run build`, sign the exe and attach `ForeverAICompanion.exe.sig` to the GitHub release next to the exe.
- Guide edits: re-sign the guide and commit `wow-forever.md.sig` with every edit. An edit without a new signature is ignored by the apps.
- One-time setup: create a P-256 key (Key Vault recommended) and paste its public key into `TRUSTED_KEYS`. See "Signing key" in the README.
- Tests: 121 run, 117 pass, 4 skipped (Windows only), 0 fail.

### Not yet verified on Windows

These parts depend on Windows and were only covered by unit tests and generated-script checks. Test them on a Windows PC before releasing:

- turning invisible sending on and off, and the update prompt on an existing install;
- saving and loading an API key (DPAPI through PowerShell);
- Codex search and in-app install (Authenticode check);
- the voice engine under SAPI (it was compiled and its message filter tested with Mono only).
