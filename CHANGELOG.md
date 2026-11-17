# Changelog

## 2.2.0 (addon 1.17.0)

### Added

- **A flat, minimal window style.** Options > AddOns > Forever AI Companion > Window style: **WoW style** (the game's own art, the default) or **Flat and minimal** (dark, with blue highlights). The chat window switches at once, without `/reload`, and the choice is kept for the whole account. Everything works the same in both: chats, messages and item links, suggestions, voice questions, compact answers, dimming and the combat warning.
  - Flat: solid dark panels with thin edges, the assistant's round portrait inside the top bar without its gold ring, blue for your messages, the selected chat and the Send button, a plain "x" to close, and thin scroll bars.
  - The compact answer box, the minimap button and the red combat warning keep their look.

### Changed

- **The AI sticks to what you asked.** It uses the parts of your character's data that matter to the question and no longer comments on the rest, for example bag space with 5 free slots.
- **Reminders only when they would hold you back.** After an answer it may add one short reminder (two at most), on its own last line, and only past these thresholds:
  - repair: a broken item, durability 20% or less, or 40% or less before a dungeon, a raid or a long trip (with the cost when a vendor that repairs is open);
  - bag space: 2 free slots or fewer, or 4 or fewer before a dungeon or a farming or gathering trip (sell greys; leave crafting materials at a bank you're in or passing);
  - an empty gear slot, or a clear upgrade sitting in your bags;
  - spells to train at your level, unspent talent points, or an important ability on none of your bars;
  - a weapon skill 25 or more points under its cap;
  - riding, once you have the level and the money the guide gives;
  - hunters: an unhappy pet, pet training points to spend, and ammo under 200 before a dungeon or a long trip, or under 100;
  - a finished quest whose turn-in is close or on your way;
  - hearthstone and rested XP, only for travel or leveling questions.

  A reminder already given in the chat isn't repeated, and on a hardcore character a real danger comes first in the answer, not as a reminder.

## 2.1.0 (addon 1.16.0)

Upstream 1.11.1 (commit `98e5519`) merged into this fork's 2.0.0 work, Windows only. It was tested on Windows first as a sync test build with upstream's version numbers (app 1.11.1, addon 1.11.10).

### Kept from upstream 1.11.0 and 1.11.1

- **Asking in combat**, with a combat warning: a red bar with your health, and a red glow inside the window each time you get hit. Here it's a choice in the options (see below).
- **Slow answers aren't lost.** A question sent through the invisible voice with no answer after 45 seconds is sent again through the on-screen line with the same id, the voice is only given up when nothing comes back at all, and an answer that arrives late is still shown.
- **The button sits on the minimap's edge** and slides around it when dragged. Positions saved before are reset.
- **Dashboard in sections** (needed to play, the AI's answers, the app), with a mark on each row, a Sign in button when Claude Code or Codex is signed out, a row for your own notes and a shorter list of recent questions.
- Mailboxes: one per answer again, longer silent signals, and a "Reload" prompt when they run out.
- Errors nobody caught are written to the log before the app closes, and the app can't quit twice.
- Tests give the same results on any machine language and line endings.

### Left out (this fork is Windows only)

- **The Mac version**: the native app, its silent voice, Keychain-encrypted keys, Mac updates and the Mac build (with its `postject` build dependency). The addon's few runtime checks for Mac clients stay, so the addon stays close to upstream.
- **The CurseForge upload** (script and workflow). This fork doesn't publish there, and the zip it built would have carried one PC's request key to every player.
- Upstream's Mac folder names in the Codex disk search, which also made the Windows search skip folders named `dev`, `music`, `system` and so on.
- **The GitHub Actions Windows build** (`.github/workflows/build-windows.yml`) and its smoke test (`scripts/smoke-windows.mjs`). Its test question carries no request code and its test update no signature, so it couldn't pass in this fork. `CLAUDE.md` lists everything left out and what a pull request to upstream would need back.

### Changed in this fork

- **In combat: dim or warn.** Options > AddOns > Forever AI Companion, "In combat": **Dim the window in combat** (the default, as before) or **Show the combat warning instead**. Ticking one unticks the other. With the warning, the window stays fully visible for the whole fight, moving too, so the warning can be seen; with dimming, the bar and the glow stay hidden. A setting saved by an earlier test build with combat dimming turned off becomes the warning.
- **Voice questions in combat**, like typed ones.
- **A code instead of the request key.** Every request carries HMAC-SHA256(this PC's key, the request's id) instead of the key itself, so the key never appears on the on-screen line (which screenshots, recordings and streams can see) or in the voice's inbox. A code fits only its own id, the app answers an id once, and ids more than a day old are refused. An addon loaded before the update is told to `/reload`.
- **Resends never become recordings.** A slow question is sent again as text only. Voice questions are never sent again and don't count against the voice. A resend doesn't open the window or the compact box.
- The combat warning checks whether the game hid a value before comparing it, so it can't raise "secret value" errors.
- Building: upstream moved the bundling step into `scripts/bundle.js`; the microphone helper is embedded there too.

## 2.0.0 (addon 1.15.0)

Based on upstream app 1.10.1 and addon 1.10.9 (commit `4acd431`). Upstream 1.10.1 merged this fork's security hardening (lucasmenares/forever-ai-companion pull request #1), all of it except signed updates and signed guides, and added changes of its own (see "Merged from upstream 1.10.1" below). On top of upstream, this release:

- keeps updates and guide downloads signed (findings 2 and 3 of the v1.9.0 security review), now including the detailed topics file;
- adds voice questions: hold a key, ask out loud, and get the answer in the chat, transcribed by OpenAI;
- adds compact answers: a small box that shows the answer instead of opening the window;
- dims the chat window while moving and in combat;
- adds a settings page in Options > AddOns.

No npm dependencies were added. Compared with upstream 1.10.1, the exe is about 100 KB larger: about 29 KB of app code and 68 KB of addon, window and C# files embedded in it.

Updates and guide downloads stay off until a signing key is in `TRUSTED_KEYS` (see "Signing key" in the README).

### Merged from upstream 1.10.1

#### Added upstream (1.10.0 and 1.10.1)

- **Detailed WoW Forever topics** (`knowledge-builtin/wow-forever-topics.md`): dungeons and raids, zones and leveling, travel, reputations, PvP, classes and races, professions and systems. Each question gets only the sections that match it.
- **Tokens in the chat:** each answer shows the tokens it used, and the chat's total sits under the text box. Hovering shows what was read, cached and written.
- **More game context for the AI:** pet abilities and Beast Training, weapon skills, item effects, action bars, rested XP, target details, recent errors and deaths, flight map, auction house and remembered prices.
- **Suggested questions for the window that is open** (vendor, auction house, trainer...) in a new chat.
- **Update invisible sending notice** next to the clock and at the top of the dashboard, with a one-click button.
- Corrected base guide, and an MIT license.

#### Changed in this fork

- **The topics file is signed like the base guide.** A downloaded `wow-forever-topics.md` is used only with a valid `wow-forever-topics.md.sig`, checked when it is downloaded and every time it is read from disk. The file name is part of what is signed, so the base guide's signature can't pass for the topics file, or the other way round. `scripts/sign.js guide` signs either file.
- **Addon 1.15.0**, above upstream's 1.10.9 and this fork's 1.14.3 test builds, so the app replaces the addon in the WoW folder.
- Tests: 172 run, 168 pass, 4 skipped (Windows only), 0 fail.

### Compact answers

#### Added

- **Compact answers** (off by default; Options > AddOns > Forever AI Companion, or `/ia compact`). Asking with the chat window closed (talk key, `/ia talk`, `/ia <question>`) no longer opens it.
  - A small, slightly see-through box shows "Listening...", then "Thinking...", then the answer with what was asked.
  - It goes away after 20 seconds (5 to 60, adjustable). Hovering keeps it up, and it stays at least 5 more seconds after the mouse leaves.
  - Item links in it work like in the chat. It can be dragged, and remembers where.
  - **Open in chat** opens the chat. The answer is in the chat as usual, with the floating button's unread badge.
  - An answer to a question asked in the window that arrives after the window was closed also goes to the box, instead of the notification card.
  - Problems (in combat, a question already being sent, no invisible sending) show in the box instead of the hidden window.
- The options page scrolls, so its three sections fit any screen.

#### Fixed

- **Invisible sending kept pointing at another copy of the app.** After installing into a different folder (for example a test install, then the normal one), the game still loaded the silent voice from the first folder, and invisible sending broke once that folder was deleted. The installed app now points the per-user voice registration at its own copy when it starts. No permission prompt is needed, and test installs (`FAIC_INSTALL_DIR`) leave it alone.

#### Changed

- **Dimming while moving defaults to 50% opacity and 1 s**, dim enough to see past and still readable on the move. Combat stays at 30% and 2 s.

### Chat window dims while moving or in combat

#### Added

- **The chat window dims while the character moves** (walking, running, riding, swimming) and returns to full a moment after stopping.
- **It also dims in combat**, and returns to full a moment after the fight ends. When the character is both moving and fighting, the lower opacity is used.
  - It stays fully visible while the mouse is over it, while typing in it, while asking by voice, and on flight paths.
  - Opening it while moving or in combat shows it fully until the character stops or the fight ends.
- **Settings page in Options > AddOns > Forever AI Companion**, also opened by a new gear button in the window and by `/ia options` (`/ia opciones`).
  - While moving: on/off, opacity 10 to 95%, delay before returning to full 0 to 10 s in 0.5 s steps.
  - In combat: the same three settings of its own.
  - Moving defaults to on, 50% and 1 s; combat to on, 30% and 2 s.
  - A changed opacity is previewed on the window for a moment.
  - Settings are saved for the whole account, and only the ones the player changes are saved, so a later default change reaches everyone who never changed that setting. Values the 1.12.0 to 1.13.0 test builds saved on their own (60% and 1 s for moving) are dropped once, so those installs use the current defaults; other choices are kept.

#### Fixed

- **In combat the dimming stopped, with Lua errors** ("attempt to compare a secret number value"), so after hovering the window it stayed fully visible until the fight ended.
  - This client hands addons some values as "secrets" during combat, including the character's speed. Addons can pass them along but can't compare them, so the dimming check errored every time and the window froze at whatever opacity it had.
  - Movement is now read from `IsPlayerMoving()` first (what ForeverForge uses), then the speed, then the game's started/stopped-moving events. Every value is checked for being a secret before it's compared, and combat comes from `InCombatLockdown()`.
  - If anything unexpected still fails, the window shows fully instead of freezing, and `/ia status` says why.
- Hovering no longer counts while turning the camera with a mouse button held (the hidden cursor stays where it was), for the window and the compact answer box.

### Voice questions

#### Added

- **Voice questions.** Hold a talk key (Key Bindings > Forever AI Companion > Talk to your assistant), click **Talk** in the chat window, or type `/ia talk`, then say the question.
  - The addon sends a "listen" request with the character data through invisible sending, and the app records until the key is released or the player pauses (30 s at most).
  - The recording is transcribed with OpenAI's transcription API, using game names from the character data as hints.
  - The app answers it like a typed question, and the chat shows the words it heard.
  - Follow-up questions by voice continue the open chat.
- **Settings in the app window** ("Voice questions"): on/off (off by default), the OpenAI key (the ChatGPT key is reused when there is one, and a separate key is encrypted with DPAPI), the model, and a microphone test.
- **Microphone helper** (`mic/Mic.cs`), compiled on the PC like the tray icon. It keeps the microphone closed except while recording, plays a start and an end beep, and exits if the app goes away.

#### Fixed

- **Key Bindings showed a dead "HEADER_FOREVERAICOMPANION" row** under "Other". The talk key now has its own "Forever AI Companion" section (a `category`, as Questie does, instead of a `header`). An existing binding is kept.

#### Security

- **Request key.** The app writes a random key into the addon folder (`RequestKey.lua`), every request from the addon carries it, and the app ignores requests without it on every channel. This closes a gap where any program able to speak with the silent Windows voice could send the app questions, and with voice questions open the microphone. It was suspected that web pages could too, through the browser's text-to-speech, but Chrome turned out not to offer the voice to web pages (tested on Windows). An addon loaded before the update is told to `/reload`.
- Audio is never written to disk. The key is never logged.

#### Tested on Windows

Microphone capture, OpenAI transcription with the answer from another AI, and the talk key were confirmed in the game. See `docs/voice-questions.md` for what is still open.

### Security hardening

This update addresses the seven findings of the v1.9.0 security review. Upstream 1.10.1 includes all of it except signed updates and the guide signatures (the guide fencing is in). No npm dependencies were added: everything uses Node's built-in `crypto` or tools that ship with Windows. The bundled code grew by about 15 KB.

#### Security

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

#### Changes players will notice

- On PCs where invisible sending is on, the app offers **Update invisible sending** once: one UAC prompt, then restart WoW. Until then it keeps working as before.
- Updates and guide downloads stay off until a signing key is pinned in `TRUSTED_KEYS`. Without a key, the app uses the guide built into it and does not update itself.
- `/ia probe` now takes two steps. The addon first asks the app to start recording (the chat shows the app's "Recording" answer) and runs the probes only after that answer arrives. If the app doesn't answer within 60 seconds, the test doesn't run and the addon says so.
- If a future Codex stops accepting one of the safety switches, questions fail with a message asking to update the app or choose another AI.
- The Codex PC search skips copies that aren't signed by OpenAI and logs which ones it skipped.

#### Compatibility and upgrade notes

- **API keys:** the move to encrypted keys is one-way. An older version of the app can't read encrypted keys, so after a downgrade the keys must be pasted again.
- **Guides from earlier versions:** a guide or topics file downloaded by an earlier version, or by upstream 1.10.x, has no signature, so it is ignored and the built-in copy is used instead.
- **Mixed app and addon versions:** the channel test works with mismatched versions. A new app with an old addon reports "run the test again" on the first run. An old app with the new addon answers the start request as an ordinary question, and the test continues.
- **Update source:** updates and the guide now come from `RELEASE_REPO` in `companion/src/config.js`. It is currently set to `zemnexx/forever-ai-companion-zemmod`, which should be the repository whose maintainer holds the signing key.

#### For maintainers

- New files:
  - `companion/src/signing.js`: signature checks and the `TRUSTED_KEYS` list.
  - `companion/src/secrets.js`: DPAPI encryption of API keys.
  - `companion/scripts/sign.js`: `keygen`, `pubkey`, `release`, `guide`, plus `digest` and `attach` for Azure Key Vault.
  - `companion/test/secrets.test.js`.
- Release process: after `npm run build`, sign the exe and attach `ForeverAICompanion.exe.sig` to the GitHub release next to the exe.
- Guide edits: re-sign the guide and commit `wow-forever.md.sig` with every edit. An edit without a new signature is ignored by the apps.
- One-time setup: create a P-256 key (Key Vault recommended) and paste its public key into `TRUSTED_KEYS`. See "Signing key" in the README.
- Tests: 121 run, 117 pass, 4 skipped (Windows only), 0 fail.

#### Tested on Windows

- Confirmed: invisible sending with the protected voice copy, the silent voice under SAPI, and API keys saved and read back encrypted (OpenAI and Claude keys).
- Not covered yet: Codex search and in-app install (the Authenticode check), since testing used API keys.
