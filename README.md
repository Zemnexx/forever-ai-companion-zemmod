<p align="center">
  <img src="companion/assets/icon-256.png" width="128" alt="Forever AI Companion">
</p>

<h1 align="center">Forever AI Companion</h1>

<p align="center">
  Your AI assistant inside <b>World of Warcraft: Forever</b>.<br>
  Ask anything without leaving the game: the AI already knows your character.
</p>

<p align="center">
  <a href="https://github.com/lucasmenares/forever-ai-companion/releases/latest/download/ForeverAICompanion.exe"><b>⬇ Download for Windows</b></a>
</p>

<p align="center"><sub>English and Spanish · Inglés y español</sub></p>

<p align="center"><sub>Unofficial fan project, not affiliated with Blizzard. Use it at your own risk: <a href="#blizzards-rules-and-your-own-risk">read the risks</a>.</sub></p>

<p align="center">
  <img src="docs/in-game-item-links.webp" width="900" alt="The Forever AI Companion window in WoW Forever: the player links the Naga Heartpiercer and asks if their equipped weapon is better; Fizzi answers with clickable item links, compares weapon DPS and stats, and suggests the Shrapnel Blaster quest reward">
  <br>
  <sub>Ask Fizzi anything: the answer uses your own level, quests, location, bags and gear. Link items with shift-click, and the assistant links items back in its answers.</sub>
</p>

---

## Contents

- [What it is](#what-it-is)
- [Installation (3 minutes)](#installation-3-minutes)
- [Using it in the game](#using-it-in-the-game)
- [Which AI to choose](#which-ai-to-choose)
- [Languages](#languages)
- [How it works](#how-it-works)
- [The WoW Forever guide and its updates](#the-wow-forever-guide-and-its-updates)
- [Privacy and safety](#privacy-and-safety)
- [Blizzard's rules and your own risk](#blizzards-rules-and-your-own-risk)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Uninstalling](#uninstalling)
- [For developers](#for-developers)

---

## What it is

Forever AI Companion has two parts that work together:

| Part | Where it lives | What it does |
|---|---|---|
| **The addon** | Inside WoW Forever | The floating button, the chat window and your assistant. It reads your character's data and shows the answers. |
| **The app** (`ForeverAICompanion.exe`) | On your Windows PC | Receives your question, asks the AI you chose and sends the answer back to the game. |

With every question the AI receives, without you having to explain anything:

- your **character**: race, class, level, experience, talents and stats;
- your **gear** slot by slot, what's in your **bags** and your bank;
- **where you are**: zone and coordinates;
- your **quests** with progress, rewards and the real coordinates of where to do them;
- **professions**, reputations, dungeon lockouts, group and target;
- the **items you link** in the question, the **window you have open** (a quest, a vendor, a trainer, loot) and your **recipes**.

So you can ask things like *"What should I do now?"*, *"Is this ring better?"* or *"Which dungeon should I run?"* and get an answer for **your** character.

You get an assistant with personality: **Fizzi**, a gnome inventor, for the Alliance, or **Rizzik**, a goblin dealer, for the Horde.

---

## Installation (3 minutes)

**Requirements:** Windows 10 or 11, WoW Forever installed, and an AI (see [Which AI to choose](#which-ai-to-choose): with Claude Pro/Max or ChatGPT Plus/Pro you pay nothing extra).

### 1. Download and open the app

1. Download [**ForeverAICompanion.exe**](https://github.com/lucasmenares/forever-ai-companion/releases/latest/download/ForeverAICompanion.exe).
2. Double-click the file.

> **Does "Windows protected your PC" appear?** That's normal for new programs that don't have a digital signature yet. Click **More info** and then **Run anyway**.

The app installs itself for your user (no permissions needed), creates a **Forever AI Companion** shortcut on the desktop and in the Start menu, and opens its window. You can delete the downloaded file afterwards.

### 2. Follow the app's setup

The window guides you step by step:

| Step | What to do |
|---|---|
| **Your game** | It usually finds WoW Forever by itself. If not, click **Choose folder…** and pick the *World of Warcraft* folder. |
| **The addon** | Click **Install the addon**. |
| **Your AI** | Choose who answers (see [Which AI to choose](#which-ai-to-choose)), follow the steps shown and click **Save and test**: you'll see a sample answer. |
| **Invisible sending** (optional, recommended) | Choose how your question travels from the game to the app ([explained below](#how-your-question-travels-invisible-or-on-screen-line)). |
| **Done** | Leave **Open when Windows starts** on so you never have to remember to open the app. |

### 3. Restart WoW

If the game was open, **close it completely and open it again** (`/reload` is not enough the first time).

### Updating

**From version 1.7.0 on, the app updates itself.** Every few hours it checks this repository for a new release. When there is one, you get a notice next to the Windows clock and an **Update now** button in the app's dashboard: one click downloads it, checks that it is exactly the file published here (SHA-256) **and that it is signed with the project's key** (`ForeverAICompanion.exe.sig`, see [Releasing a new version](#releasing-a-new-version)), and restarts the app with the new version, keeping your chats, settings and keys. A release without a valid signature is never offered or installed, and a copy of the app built without a signing key does not update itself. The addon is updated with it (restart WoW or `/reload` afterwards).

For older versions, download the new `.exe` and open it: it replaces the old version in the same way.

The WoW Forever guide the AI uses updates by itself from the internet, with nothing to download (only signed guides are used, see [below](#the-wow-forever-guide-and-its-updates)).

Coming from version 1.5.0 or earlier, the app and the addon move to new folder names on their own: your chats, settings and API keys come along. Restart WoW once afterwards. If you use invisible sending, the app window will offer **Update invisible sending** (Windows asks for permission once); until then it keeps working as before.

---

## Using it in the game

1. **Click the floating button**: the circle with your assistant's portrait, top right next to the minimap. You can drag it anywhere.
2. **The first time, choose your assistant**: Fizzi (Alliance) or Rizzik (Horde). It suggests the one for your faction.
3. **Type your question** and click Send. The answer arrives in a few seconds; if the window was closed, you get a notification.

- **Chats by topic**: each chat remembers its conversation (gear, quests, dungeons…). Right-click the floating button to start a new chat.
- **Ask about a specific item**: while typing, shift-click an item (in your bags, a vendor, a quest reward…) to put it in the question, like in the chat box: *"Is [this ring] better than mine?"*. The AI gets its full stats, and the link stays clickable in your message.
- **Clickable items in the answers**: when the assistant names an item from your gear, bags, bank, quest rewards or an open vendor, it shows up as a real item link. Hover it for the tooltip, click to open it, shift-click to paste it in the chat or ctrl-click to try it on. Items that aren't in your data (for example, dungeon loot) are written as plain text.
- **Ask about what's open**: with a quest, vendor, trainer or loot window open, the AI sees it. Try *"Should I accept this quest?"*, *"Which reward should I pick?"*, *"What should I buy here?"* or *"What should I train first?"*.
- **Professions**: open each profession window once and the addon remembers your recipes, so you can ask *"What can I craft with what I have?"* or *"Which recipe should I make to level up?"*.
- **Is the app ready?** The line under the chat title tells you. Green: the app is open and ready. Red: questions won't be answered yet, and it says why (the app is closed or not responding, no AI is chosen, or your AI needs you to sign in). Hover it for what to do.
- **See what is sent**: in the window click **See the data I send**.
- **In combat** you can't ask (on purpose): wait until combat ends.

### Chat commands (optional)

Every command also works with its Spanish word (shown in parentheses).

| Command | What it does |
|---|---|
| `/ia` or `/ai` | Opens or closes the window |
| `/ia <question>` | Asks directly in the open chat |
| `/ia new` (`nuevo`) | Starts a new chat |
| `/ia assistant` (`asistente`) | Choose between Fizzi and Rizzik (`/ia assistant fizzi` or `/ia assistant rizzik`) |
| `/ia button` (`boton`) | Shows or hides the floating button (`/ia button reset` puts it back in place) |
| `/ia sound` (`sonido`) | Turns the answer notification sound on or off |
| `/ia data` (`datos`) | Shows the data that is sent |
| `/ia status` (`estado`) · `/ia inbox` (`buzon`) | Diagnostics: connection status and check for pending answers |
| `/ia help` (`ayuda`) | List of commands |

---

## Which AI to choose

| Option | For whom | Cost | Searches the internet |
|---|---|---|---|
| **My Claude subscription** (recommended) | You have Claude Pro or Max | Included in your plan | Yes |
| **My ChatGPT subscription** | You have ChatGPT Plus or Pro | Included in your plan | Yes |
| **Claude with an API key** | No subscription | Pay per use (≈ 1 US cent per question) | Yes |
| **ChatGPT with an API key** | No subscription | Pay per use | No |
| **Gemini** | You want to try it for free | Free usage with limits | No |
| **AI on your PC (Ollama)** | You have a powerful PC | Free, no internet | No |
| **Test mode** | Check that the game and the app are connected | Free (not an AI) | — |

With the subscriptions, the app installs the official program (**Claude Code** by Anthropic or **Codex** by OpenAI) and opens your browser to sign in. Your questions count toward your plan's usage limit.

You can change the AI or the model at any time from the app's dashboard (**Change**, next to *Artificial intelligence*).

---

## Languages

Everything is available in **English and Spanish**, chosen automatically:

| Part | Language |
|---|---|
| The addon (window, button, assistant, commands) | Your WoW client's language: Spanish for `esES`/`esMX`, English for everything else |
| The app window and the tray icon | Your Windows language: Spanish if Windows is in Spanish, English otherwise |
| The AI's answers | The language of your question, using the names your game client shows (zones, quests, items) |

To force the app's language, set `"language": "en"` or `"es"` in `%APPDATA%\ForeverAICompanion\config.json` (`"auto"` by default).

---

## How it works

For safety, WoW addons **cannot use the internet or write files**. So the question needs a way out of the game and the answer a way back in:

```mermaid
sequenceDiagram
    participant P as Player
    participant A as Addon (in WoW)
    participant W as Windows
    participant C as App (your PC)
    participant AI as Chosen AI
    P->>A: Types the question
    A->>A: Gathers the character data
    A->>W: "Reads aloud" the question with the silent ForeverAICompanion voice
    W->>C: The voice hands the text to the app (nothing is heard)
    C->>AI: Question + data + WoW Forever guide
    AI-->>C: Answer
    C->>A: Writes the answer into an addon inbox and "rings the bell"
    A->>P: Shows the answer in the chat
```

### Going out: from the game to the app

1. The addon puts your question and the character data into a JSON. To keep it light, sections that didn't change since the last question (gear, talents…) are sent only as a fingerprint, and the app fills them in from its copy.
2. It packs it with a `FAIC` mark, its length and a checksum, and sends it by one of two paths:

#### How your question travels: invisible or on-screen line

| | **Invisible** (recommended) | **On-screen line** |
|---|---|---|
| How it works | Windows has voices to read text aloud (like Narrator). The app adds a **silent** voice called *ForeverAICompanion*. The addon "reads" your question with that voice and, instead of making a sound, the voice hands it to the app. | The addon draws a thin line of dark squares along the top edge for ~0.35 s. The app reads it from the game window, like a QR code. |
| What you see or hear | Nothing | A brief flicker at the top of the screen |
| Requirements | Administrator permission once (Windows only allows adding voices that way) | WoW visible when asking (not minimized or covered) |
| What gets installed | A silent voice in Windows' voice list | Nothing |

Technically, the voice is a small SAPI engine that the app compiles on your PC with the C# compiler included in Windows. When the game asks it to speak, it saves the text in `%APPDATA%\ForeverAICompanion\tts-inbox\` instead of producing audio. Messages travel in chunks of up to 24,000 characters (a normal question is a single one) (`FAIC:<id>:<part>/<total>:<data>`) and the app joins them back.

### Coming back: from the app to the game

- Installing the addon creates **50 "inbox" addons** (`ForeverAICompanion_S01` … `S50`) that the game loads only on request. The app writes the answers into them.
- To signal an answer, the app "rings a bell": 500 `sig/NNN.wav` files start empty, and the app turns the next one into a 50 ms silent sound. Every 2 seconds the addon tries to play it; if it can, it stops it instantly and loads the next inbox, which reads the freshly written answer.
- Each inbox can be loaded once per session (that's why there are 50; `/reload` resets them). If the game's sound is off, the addon checks the inboxes on a timer.
- The same trick tells the game whether the app is ready (the line under the chat title). While the app runs it switches every 3 seconds which of `sig/beat1.wav` and `sig/beat2.wav` plays; both silent means it is closed, one stuck means it crashed or froze. `need-ai.wav`, `need-login.wav` and `problem.wav` say why it can't answer yet, and `st.wav` (always playing) shows the files existed when the game started.

That's why you need to **restart WoW** after installing: the game only sees files that existed when it started.

### What the AI receives

- **The assistant's instructions**: Fizzi's or Rizzik's personality, how to read the data and how to answer (short, with coordinates, no web links because the game can't open them). Items it saw in your data come back marked with their id (`{{item:ID|Name}}`) and the addon turns them into item links, only if that id really is the item with that name in your game.
- **Today's date and the game version**, to reason about the calendar and patches.
- **The WoW Forever guide** (see below).
- **Your data and the question**, plus the earlier questions of the same chat.
- If the AI can, it **searches the internet** when it needs a Forever-specific fact (a few seconds more). It can be turned off in the dashboard.

With the subscriptions, Claude Code and Codex run as a plain chat: our instructions replace their coding ones, with no access to your files or commands, without your settings and without saving sessions.

---

## The WoW Forever guide and its updates

WoW Forever launched on November 4, 2026, after the AIs were trained, so they don't know it from memory. That's why the AI receives a **WoW Forever base guide**: zones, dungeons with their levels, raids, the Skyborne race, system changes and the calendar. It's written in English and includes the Spanish client names (`es: ...`) so Spanish players get the names they see.

The guide is the file [`companion/knowledge-builtin/wow-forever.md`](companion/knowledge-builtin/wow-forever.md) in this repository. It starts with a header:

```
---
date: 2026-11-13       ← when it was last reviewed
gameVersion: 1.60.1    ← game version it describes
build: 70938           ← the game's build number
---
```

**How it stays current:**

- The app ships with a copy, and also **downloads the one in this repository** at startup, every 6 hours and as soon as it notices the game was updated. It only uses it if it's valid, **signed with the project's key** (`wow-forever.md.sig` next to it) and its `date` is newer; offline it uses the last one it downloaded. The signature is checked again every time the downloaded guide is read from disk.
- The guide reaches the AI fenced off as reference data: it can supply facts, but text inside it cannot change the AI's rules or role.
- The AI knows today's date and how old the guide is. If the guide is more than 21 days old, or the game is newer than the guide, it checks on the internet whatever changes with patches before stating it.

**To update the guide for every player** (without releasing a new version of the app):

1. Open [`companion/knowledge-builtin/wow-forever.md`](companion/knowledge-builtin/wow-forever.md) on GitHub and click the pencil (*Edit*).
2. Make your changes and **set `date` to today** (and `gameVersion` and `build` if there was a patch; the build is shown by `/ia data` in the game, in the *client* section).
3. Sign it: `node scripts/sign.js guide knowledge-builtin/wow-forever.md --key <key.pem>` (or the Key Vault steps in [Releasing a new version](#releasing-a-new-version)), which writes `wow-forever.md.sig`.
4. Commit both files. Within a few hours every app downloads it (or right away with **Check for updates** in the dashboard). An edit committed without a new signature is ignored by the apps.

Tips: write full dates ("opened on December 9, 2026", not "opening soon"), mark with "per guides" whatever Blizzard hasn't confirmed, and keep it under 200 KB.

Each player can also add their own knowledge from the app's dashboard (**Server knowledge…**): `.md` or `.txt` files in that folder are included with every question and take priority over the guide.

---

## Privacy and safety

- **Your data only goes to the AI you chose.** This project has no servers: it never receives your questions, your data or your keys.
- The app's only connection of its own is downloading the WoW Forever guide from this repository (a read, nothing is sent).
- API keys are stored only on your PC, in `%APPDATA%\ForeverAICompanion\config.json`, **encrypted with Windows DPAPI** for your Windows account: a copy of that file on another PC or account doesn't reveal them. Keys saved in plain text by earlier versions are encrypted the next time the app starts.
- Updates and the downloaded guide are only used when signed with the project's key (see [Updating](#updating)).
- **Invisible sending:** the silent voice's file used by elevated programs lives in `%ProgramFiles%\ForeverAICompanion`, which only administrators can change (installs from before this change are offered **Update invisible sending** to move it). The voice keeps only this app's own messages: anything else any program speaks with it is dropped without being written or logged.
- **Codex:** when the app searches the PC for Codex, or installs it, it only runs a `codex.exe` that Windows confirms is signed by OpenAI. If a future Codex stops accepting one of the safety switches the app relies on (no commands, no file or browser access), the app refuses to use it rather than dropping the switch.
- The `/ia probe` channel test only watches the game's files while a test is running (and for 15 minutes after, for files the game writes at logout).
- The app window is a local page (`127.0.0.1`) that doesn't accept connections from other computers or other web pages.
- **The game is not modified**: its memory and files are not touched, and the addon doesn't play for you. It only uses normal addon and Windows features.
- This is not a Blizzard product. Use it at your own risk (see the next section).

---

## Blizzard's rules and your own risk

> **Forever AI Companion is an unofficial fan project. It is not made, endorsed or approved by Blizzard Entertainment. You use it at your own risk, and the project is provided as is, with no warranty of any kind.**

Blizzard doesn't review or pre-approve addons or the apps that go with them, so nobody can promise you that using this one will never have consequences for your account. This section explains how the project compares with Blizzard's rules as we read them, and where the risks are, so you can decide for yourself. It is not legal advice and it is not Blizzard's opinion.

### Blizzard's addon policy

Blizzard's [UI Add-On Development Policy](https://us.forums.blizzard.com/en/wow/t/ui-add-on-development-policy/24534) sets the basic rules for addons:

| Rule | This project |
|---|---|
| Addons must be free | ✅ Free, with nothing paid or locked |
| The code must be fully visible | ✅ Readable, unobfuscated Lua. The app's code is in this repository too |
| No harm to realms or other players | ✅ It sends nothing to the realm or to other players during normal use (the optional `/ia probe` test whispers one message to yourself) |
| No ads and no donation requests in the game | ✅ None |
| No offensive content | ✅ None |
| Blizzard may disable any addon feature | Applies, see the risks below |

### Blizzard's Terms of Use

Blizzard's Terms of Use and EULA forbid bots, cheats and unauthorized third-party software that plays for you or collects information from the game. This is what the project does and doesn't do:

| | |
|---|---|
| Plays for you, presses keys or clicks | **No.** You type every question, and every answer is just text you read, like looking something up on a website. |
| Reads or changes the game's memory | **No.** It doesn't read, inject into or modify the game process. |
| Changes the game's files | **No.** The app only writes inside its own addon folders in `Interface\AddOns`. |
| Works during combat | **No.** The addon refuses questions while you are in combat, in line with Blizzard's goal that addons shouldn't give an advantage in combat. |
| Can be inspected | **Yes.** All of the code is public in this repository. |

### Where the risks are

1. **The way data leaves the game is unusual.** Addons can't use the internet or write files, so the question leaves the game through the silent Windows voice or a line of squares read from the screen, and the answer comes back through addon files and silent sounds (see [How it works](#how-it-works)). These are all normal addon and Windows features, but Blizzard didn't design them for this. Apps that write data for an addon to read have been common and tolerated for years (the TradeSkillMaster desktop app, the WeakAuras Companion, Raider.IO). Reading data off the screen, though, is also a technique cheating bots have used. Those bots are banned for playing automatically, which this app never does, but someone reviewing it could still lump them together.
2. **Blizzard can break it at any time.** If Blizzard doesn't like this kind of tool, the most likely result is a game patch that closes one of these paths, for example by limiting the text-to-speech or sound functions, rather than action against accounts. Blizzard already restricted combat addons heavily in Midnight, the engine WoW Forever runs on. If that happens, the assistant stops working until another way is found, if one exists.
3. **Action against your account is possible.** Because it doesn't automate anything or touch the game's memory, we consider the risk low, but Blizzard has the final word on what its Terms of Use allow, and its rules and how it enforces them can change. If your account matters more to you than the convenience, don't use it.
4. **The AI can be wrong.** Answers can be inaccurate or out of date, especially about things that change with patches. Double-check before spending a lot of gold or time on an answer.
5. **Your AI provider's terms apply too.** Using Claude, Codex or an API key through this app is subject to that provider's own terms and limits.

---

## FAQ and troubleshooting

**How much does it cost?**
The app is free. With your Claude or ChatGPT subscription you pay nothing extra (questions count toward your plan's limit). With an API key you pay per use.

**The answer doesn't arrive.**
- Look at the line under the chat title in the game: if it's red, it says what's wrong.
- Open the app and check that it says **Running** at the top.
- If you just installed the addon or invisible sending, close WoW completely and open it again.
- Type `/ia inbox` in the game to check for new answers.
- With the on-screen line, WoW must be visible when asking and in windowed or "fullscreen (windowed)" mode.

**I can't see the floating button.**
You may have hidden it (Shift + right-click). Type `/ia button`, or `/ia button reset` to put it back in place.

**The AI test fails.**
Check the steps in *Your AI*: the program must be installed and signed in, or the key must be complete. The error message tells you what's missing.

**Does the app need to stay open?**
Yes, while you play. When you close its window it can keep running next to the Windows clock (click the icon to open it again; right-click to close it). With **Open when Windows starts** you don't have to remember.

**Does it work on Mac?**
Not for now: Windows 10 and 11 only.

---

## Uninstalling

Open the app and, under **More options**, click **Uninstall**. It removes the addon, the inboxes, the invisible voice, your settings, the shortcuts and the program.

---

## For developers

### Structure

```
addon/ForeverAICompanion/   Addon (Lua 5.1, modern client, interface 16001)
  Locale.lua                English and Spanish texts (by the client's language)
  Collect.lua               Reads the character's data (each section separately),
                            linked items, open windows and recipes
  Uplink.lua                Game → app: builds the package and picks the path
  Voice.lua                 Invisible path (text to speech with the silent voice)
  Live.lua                  App → game: inboxes and bell
  UI.lua Button.lua         Chat window and floating button
  Chats.lua Notify.lua      Conversations and notifications
  Personas.lua              Fizzi and Rizzik
  Core.lua                  Events and /ia commands
companion/
  src/app/                  App: main (self-install, tray), controller,
                            server (local window), system (Windows), ui.html
  src/i18n.js               English and Spanish messages (app, tray, in-game errors)
  src/watcher.js            Receives questions and publishes answers
  src/voice-inbox.js        Reads what the silent voice delivers
  src/screen-reader.js      Reads the on-screen line
  src/grid.js image.js      Decodes the line
  src/inbox.js              Inboxes and bell
  src/beacon.js             Tells the game whether the app is open and ready
  src/updater.js            Updates the app from GitHub releases
  src/signing.js            Checks the signatures of updates and the guide
  src/secrets.js            Encrypts API keys in config.json (Windows DPAPI)
  src/prompt.js             Instructions for the AI
  src/guide.js              WoW Forever guide: date, version and downloads
  src/providers.js          Claude, OpenAI/Gemini/Ollama, Claude Code, Codex, test
  src/codex.js              Codex: install, sign-in and running it
  src/claude-code.js        Claude Code: install and sign-in
  src/tts-voice.js          Installs the silent voice
  src/migrate.js            Moves installs from the project's previous name
  tts/ForeverAICompanionTts.cs  Silent voice engine (C#)
  tray/Tray.cs              Icon next to the clock (C#)
  knowledge-builtin/        WoW Forever guide
  scripts/build.js          Packages ForeverAICompanion.exe
  scripts/sign.js           Signs releases and the guide (local key or Key Vault)
  test/                     Tests (they run the addon's real Lua)
```

### Build and test

Requirements: Windows and Node.js 25.5 or later (for `--build-sea`; Node 22 is enough for development).

```bash
cd companion
npm install
npm test            # tests
npm run app         # the app with its window, from source
npm run build       # creates dist/ForeverAICompanion.exe
```

The `.exe` is a single executable (Node SEA) that includes Node.js, the app, the addon, the guide and the icons. The C# helpers (silent voice and tray) are compiled on the player's PC with the .NET Framework compiler included in Windows.

Terminal mode, without a window:

```bash
npm run install-addon -- --wow "C:\path\World of Warcraft\_forever_"
npm start
npm run ask -- "Which dungeon do you recommend?"
```

Test variables: `FAIC_DATA_DIR` (data folder), `FAIC_WOW_DIR`, `FAIC_PROVIDER`, `FAIC_NO_SHORTCUTS`, `FAIC_LANG` (`en` / `es`), `FAIC_INSTALL_DIR` (install into a test folder; nothing machine-wide is touched) and `FAIC_UPDATE_API` (a local stand-in for GitHub's latest-release API, for testing updates; its releases must still be signed with a key in `TRUSTED_KEYS`). `.exe` arguments: `--no-install`, `--no-window`, `--background`.

### Signing key (one-time setup)

Installed apps only accept releases and guides signed with a key listed in `TRUSTED_KEYS` (`companion/src/signing.js`). The signatures are ECDSA P-256 / SHA-256 (ES256), checked with Node's built-in crypto. While `TRUSTED_KEYS` is empty, the app does not update itself and only uses the guide built into it. Updates and the guide are read from the repository in `RELEASE_REPO` (`companion/src/config.js`), which should be the one whose maintainer holds the key.

Recommended: an Azure Key Vault key that never leaves the vault.

```bash
az keyvault key create --vault-name <vault> --name faic-signing --kty EC-HSM --curve P-256 --ops sign verify
```

```bash
az keyvault key download --vault-name <vault> --name faic-signing --encoding PEM --file faic-signing.pub.pem
```

```bash
node scripts/sign.js pubkey faic-signing.pub.pem
```

Or a local key, kept outside the repository and backed up:

```bash
node scripts/sign.js keygen <folder outside the repo>/faic-signing.pem
```

Paste the printed public key into `TRUSTED_KEYS`. To rotate, add the new key, release with the old one, then sign with the new one and remove the old key in a later release.

### Releasing a new version

Installed apps (1.7.0 and later) pick up every new release by themselves (`src/updater.js`), so:

1. Bump the number in `companion/src/app/controller.js` (`VERSION`) and, if the addon changed, in `addon/ForeverAICompanion/ForeverAICompanion.toc`. If Blizzard raised the game's interface number, update `## Interface:` in the toc too, or WoW will treat the addon as out of date.
2. `npm test` and `npm run build`.
3. Sign the exe. The signature covers its name, `VERSION`, size and SHA-256, so it can't be reused for another file or version. With a local key: `node scripts/sign.js release dist/ForeverAICompanion.exe --key <key.pem>`. With Key Vault: `node scripts/sign.js digest release dist/ForeverAICompanion.exe`, then `az keyvault key sign --vault-name <vault> --name faic-signing --algorithm ES256 --digest <digest>`, then `node scripts/sign.js attach release dist/ForeverAICompanion.exe <signature>`.
4. On GitHub, **Releases → Draft a new release**, create the tag **`v` + the exact `VERSION`** (for example `v1.7.0`) and attach `dist/ForeverAICompanion.exe` and `dist/ForeverAICompanion.exe.sig` with those exact names. Don't mark it as a pre-release (pre-releases are not offered to players). The README's download link and the in-app updater always use the latest release.

### To do

- **Code signing** for the `.exe` to remove the SmartScreen warning (a code signing certificate or Azure Trusted Signing). This is separate from the update signature above, which the app checks itself.
- Ask Blizzard (a support ticket or the official UI & Macro forum) whether this kind of companion app is allowed, and update [Blizzard's rules and your own risk](#blizzards-rules-and-your-own-risk) with the answer.
