# Changelog

## 2.3.0 (addon 1.17.0)

The Armory: a second addon for your character's build, on top of the plugins of 2.2.0.

### Added

- **The app installs the Armory and keeps it up to date.** The dashboard has a new section, **The Armory**: click **Set up**, then **Install the Armory**, and the addon is copied next to the main one. From then on the app replaces it whenever the installed files are not the ones the app carries (a newer version, or a test build that keeps the version number). It is never installed unless you ask, **Remove** takes it out again, and uninstalling the app removes it too. Restart WoW after installing.
- **Your own settings for the Armory's analyses**, on the same screen:
  - **How thorough**: Quick, Balanced or Thorough (the default). More gives better builds and uses more of your plan or key.
  - **Model for the analyses**: the same as the chat, or another model of the AI you chose, for example Sonnet for the chat and Opus for builds. The choice is kept per AI option, so changing your AI never leaves a model the new one doesn't have.
- **Answers are heard again on a game that says yes to every sound file.** The addon knows an answer is ready because a sound file that was empty now plays. WoW Forever 1.60.1 on Windows says an empty file plays too, as a Mac does: every bell looked rung at login, the app's status read "unknown", and answers were only picked up by a slow timer, never once the wait was over. Such a game is now recognized by what it does (both of the app's beat files "playing" at once, which the app never allows) and its files are checked a moment after they start, the way already used on a Mac. Bells it had miscounted are counted again.
- **The addon keeps listening whatever goes wrong.** The timers that pick up the app's answers are guarded: a failure inside one no longer stops them for the rest of the session. A plugin may wait up to 30 minutes for its answer, and `ForeverAICompanionAPI.Diagnose()` tells in a few lines whether answers can get back (sound, bells, mailboxes, timers, the app's beat) and what is being waited for.
- **The addons' files follow the app's.** An installed addon is replaced when its files are not the ones the app carries, not only when the version number differs, so a version that is still being tested keeps its number.
- **The Armory's side of the app** (`companion/src/armory`), for the [Forever AI Companion: Armory](https://github.com/Zemnexx/forever-ai-companion-armory) addon. It uses the AI you already chose, with room for a longer answer and more patience than a chat question (`"armory"` in `config.json`: `maxTokens`, `timeoutMs`, `iterations`, besides the two settings above).
  - **Talent builds.** The AI proposes the order in which to spend every point from your class's real talent trees, and the app replays that order under the game's rules (points per row, prerequisites, maximum ranks). Points the game would not accept never reach you, and a build with holes is sent back to the AI once with what was wrong.
  - **Gear plans.** Upgrades per slot with where each comes from, stat weights for scoring items in the game, and item ids so each pick shows the item's own tooltip in the game. The app confirms every id against Wowhead's WoW Forever item data (only the id numbers are sent) and drops one that belongs to another item or to none. Picks without an id are looked up afterwards in a short, separate request to the AI, checked the same way and asked once more for what is still missing, so the main analysis no longer spends its searches on ids. The addon still checks each id against the game.
  - **Rotations, by simulation.** The AI writes a combat model of your character from your spells' tooltips, talents and stats, with a few candidate rotations. A simulator in the app (`sim/engine.js`: swing timers, the classic attack table, armor, cooldowns, resources, damage over time, buffs and procs) runs each one for hundreds of fights, ranks them, and measures what each stat is worth by simulating again with a little more of it. A model the simulator can't run is sent back once with the problems it found.
  - **Interactions.** The AI looks for combinations of your talents, spells and item effects that are stronger than they look. An idea that changes your numbers comes with a change to your combat model, and the simulator measures it against your last rotation.
  - **Test mode answers too.** With no AI chosen, every kind of request gets a placeholder made from your own data through the same checks and the same simulator, so the connection can be tried for free.
  - Not yet: pets are not simulated. Hunters and warlocks are told so under each rotation's assumptions.

## 2.2.0 (addon 1.17.0)

### Added

- **Other addons can ask the app through this one.** The addon now has a small public API (`ForeverAICompanionAPI`, in `Plugins.lua`) that a second addon can use to send the app a request and get data back, over the same channels and with the same per-PC request code as a question. The app answers such a request only when it has a plugin of that name (`companion/src/plugins.js`), and what a plugin tells the AI is written in the app, never taken from the request. This version carries no plugin yet: it is the groundwork for the Armory of 2.3.0. See [Plugins](README.md#plugins-other-addons-asking-through-this-one) in the README.
  - A plugin's own data is sent only when it changed, like your character's.
  - A request that is waiting for its answer survives `/reload` and closing the game: the answer is handed over the next time you log in. An answer that is only late is still picked up.
  - While a plugin's request is being worked on, a question you ask in the chat is still answered: plugin requests wait in a line of their own.
  - Mailboxes are opened less often while waiting for a plugin's answer, which can take minutes, so they last as long as before.

### Fixed

- **Answers with certain field names no longer break the mailbox.** A table key that is a Lua keyword (`for`, `end`...) was written bare into the mailbox file, which the game could not load. No answer had such a key until now.

## 2.1.2 (addon 1.16.14)

### Added

- **The AI knows which quests you've done and which ones you can pick up.** Every quest you turn in is kept with its zone, and the AI gets how many quests you've completed and the ones done in your current zone (up to 40 with how many more there are, or all of them when you ask about quests). With the QuestieDB addon installed (it comes with Questie), it also gets:
  - the names of quests you completed before, in your current zone (the game keeps every completed quest; QuestieDB knows their names and zones);
  - the quests you can pick up now in your current zone (or that there are none left there) and in the nearest zones your quests come from or send you to, on your continent first: right level (not grey or red), race and class, prerequisites done, not done and not in your log, and no reputation to earn with a faction you're Hostile or Hated with (such as the Gelkis once you side with the Magram), with the quest giver and its coordinates. With Questie loaded too, Questie's own check is applied on top (the quests it hides, daily and event rules, quests you hid in Questie), so the list matches the "!" Questie shows. Name another zone in your question and its quests, and the ones you've done there, go along with that question;
  - where a quest you name in your question (or shift-click into it) stands: done, in your log, available (with the quest giver and coordinates, and whether it's grey or red for you), or not yet with why (the level, the quests to finish first, a reputation, closed by another quest you did, hidden by Questie). For a chain whose parts share a name, the part to do now and how many are done;
  - for each quest in your log, the next quest of its chain.

  It recommends new quests only from that list, never one you've done. The addon reads QuestieDB in the background, a little each frame and never in combat, so the game doesn't stutter. Without QuestieDB everything else works as before.
- **The compact answer box can be resized.** Drag its bottom-right corner, from 240 to 900 pixels wide and 110 to 700 tall. It keeps that size the next time it opens, and a long answer scrolls inside it. Right-click the corner to go back to the automatic size (380 wide, as tall as the answer).
- **A flat, minimal window style.** Options > AddOns > Forever AI Companion > Window style: **WoW style** (the game's own art, the default) or **Flat and minimal** (dark, with blue highlights). The chat window switches at once, without `/reload`, and the choice is kept for the whole account. Everything works the same in both: chats, messages and item links, suggestions, voice questions, compact answers, dimming and the combat warning.
  - Flat: solid dark panels with thin edges, the assistant's round portrait inside the top bar without its gold ring, blue for your messages, the selected chat and the Send button, a plain "x" to close, and thin scroll bars.
  - The compact answer box, the minimap button and the red combat warning keep their look.

### Changed

- **The AI sticks to what you asked.** It uses the parts of your character's data that matter to the question and no longer comments on the rest, for example bag space with 5 free slots.
- **Reminders only when they would hold you back.** After an answer it may add one short reminder (two at most), on its own last line, and only past these thresholds:
  - repair: a broken item, durability 20% or less, or 40% or less before a dungeon, a raid or a long trip (with the cost when a vendor that repairs is open);
  - bag space: 2 free slots or fewer, or 4 or fewer before a dungeon or a farming or gathering trip (sell greys; leave crafting materials at a bank you're in or passing);
  - an empty gear slot, or a clear upgrade sitting in your bags;
  - spells to train at your level, or unspent talent points;
  - a weapon skill 25 or more points under its cap;
  - riding, once you have the level and the money the guide gives;
  - hunters: an unhappy pet, pet training points to spend, and ammo under 200 before a dungeon or a long trip, or under 100;
  - a finished quest whose turn-in is close or on your way;
  - hearthstone and rested XP, only for travel or leveling questions.

  A reminder already given in the chat isn't repeated, and on a hardcore character a real danger comes first in the answer, not as a reminder.
- **Recipes only go with crafting questions.** They are the longest part of your data (about 1,500 tokens for three professions), so the app now sends them only when the question is about crafting, names a profession, a recipe or one of its materials (also in the question just before), or a trainer's window is open. Your profession skill levels still go with every question. Recipes that no longer give skill go as a plain list of names, a third of the size.
- **It searches instead of guessing from Classic.** When the AI wasn't sure whether Forever changed something, it answered with what the original game had and added that Forever may have changed it. Now that doubt makes it search first, and it answers from memory only when it's sure the fact is the same in Forever. If it can't confirm it after searching, it gives what the Forever guides say and that it may not be exact. Without search (an OpenAI API key, or **Search the internet** off), it still says when an answer comes from the original game.
- **No more reminders about abilities missing from your bars.** They kept naming abilities your spec doesn't use. The AI still knows which abilities are on no bar, and uses that only when you ask about your bars, keybinds, rotation or a spell you can't find.

### Fixed

- **Your saved data survives Forever's blank realm name.** Since the game's build 71037 the realm's name comes back blank, so the addon started a new, empty store for your character and lost track of what it had saved before (Eastern Kingdoms flight points, quest turn-ins, auction prices, the assistant you chose). Each character's data is now kept by the character's own game id, which doesn't depend on the realm's name, and the first time the old stores are merged into it (the newer copy wins). Auction prices are kept per server and faction. A blank realm is no longer sent to the AI.
- **Recipes are saved on WoW Forever.** Its profession window gives the profession's name through a different game function than the addon used, so no recipe was ever saved and the AI only knew your skill levels. Open each profession window once (Blacksmithing, Mining's smelting, Cooking, First Aid...) to save them.
- **The bank is remembered as you left it.** The addon saved the bank when you opened it and when its main slots changed, but not when you took things out of the bags inside the bank (or put them in), so the AI could count items you had already taken out. It now saves after every change while the bank is open, an emptied bank included. Open your bank once to refresh what it remembers.
- **Skills and spells are listed cleanly.** Each profession and secondary skill was listed twice, and the spell list had the spellbook's groups (Blessings, Auras, Utility Blessings) and the auto attack in it, as if they were abilities missing from your bars.
- **Directions no longer fly you to flight points you haven't discovered.** At each flight master, the addon now keeps both lists for that continent: the flight points you can fly to, and the ones of your faction (or neutral) you haven't discovered yet, which the game's map hides. The AI plans flights only between the ones you have, and for one you're missing it tells you to get there another way and talk to its flight master. A continent where you haven't opened a flight master's map since this update is marked as not checked, and the AI asks you to open one there. Names follow the game's current language, so they no longer show up twice after switching the client between English and Spanish, and flight points the game no longer uses (named "zzOLD...") are left out.
- **Auras, stances and forms count as on your bars.** The stance bar (paladin auras, warrior stances, druid forms, stealth, Shadowform) wasn't read, so the AI told you to drag your auras to a bar.
- **Resizing no longer jumps.** Clicking the bottom-right corner of the chat window (in both styles) made it jump to a larger size before the mouse moved, and the compact answer box could jump too. Now nothing changes until you drag: the size follows the mouse by as much as it moves, the top-left corner stays where it is, and the window stops at the right and bottom edges of the screen.
- **A spell cast from a macro no longer counts as missing from your bars.** The AI kept saying, for example, that Judgement wasn't on any bar when it was in a macro. The addon now reads which spells a macro casts: the one the game shows for it, and the names after `/cast`, `/use`, `/castsequence`, `/castrandom` and `#showtooltip`, without conditions like `[@mouseover]`, `reset=` or ranks. On newer game clients a macro's bar slot gives the spell the macro shows instead of the macro itself: that spell counts, and the macro is found by the name on its button. Bars beyond the first 120 slots are read too.

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
