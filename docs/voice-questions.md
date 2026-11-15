# Voice questions (speech to text): scope

Status: proposal. Branch: `vtt-feature` (from `security-hardening`).

## Goal

The player holds a key (or clicks a mic button in the chat window), says the question and releases. The answer arrives in the chat like a typed one, with the spoken words shown as the question.

## What shapes the design

- **Only the app can use the microphone.** WoW addons can't open it.
- **Only the addon has the character data.** Each answer the app sends back into the game uses one LoadOnDemand slot, and each slot loads once per UI session (`addon/ForeverAICompanion/Live.lua`). So the question starts in the game, carrying fresh character data, and comes back as a single answer, exactly like a typed one.
- **No typing for the player.** Typing the transcript into the chat box would mean injecting keypresses, which the README promises never to do and which crosses Blizzard's automation line.
- **The exe stays light.** No speech engine or model is bundled or downloaded. The microphone helper is compiled on the player's PC with the C# compiler included in Windows, like the tray icon.

## Flow

1. **Trigger.** The player holds a new keybind (key down to start, key up to stop) or clicks a mic button in the chat window. Not in combat, same rule as typing.
2. **Listen request.** The addon sends a request like a normal question: character data included, `listen = true`, no text. The chat shows "Listening...".
3. **Recording.** The app opens the microphone and plays a short beep so the player knows to speak.
4. **Stop.** Recording ends when the player releases the key (a tiny second message over invisible sending), after about 1.5 s of silence, or at a 30 s hard cap.
5. **Transcription.** The app sends the recording to OpenAI's transcription API in the player's language. The quest, zone and item names from the request's character data go in the `prompt` field as vocabulary hints.
6. **Answer.** The app asks the player's chosen AI with the transcript and the character data, and answers that request with both the answer and the transcript. The addon shows the transcript as the question. That's one slot, same as typing.

## Speech-to-text engine

**Proposed: OpenAI's transcription API only.**

| Option | Verdict | Why |
|---|---|---|
| OpenAI transcription API | Proposed | One `fetch` call (Node's built-in `FormData`/`Blob`), no SDK, no download, no local CPU load. Good accuracy, and a `prompt` field for game vocabulary |
| Local Whisper (whisper.cpp) | Rejected | Needs a 60 to 200 MB model plus a binary downloaded and installed, with hash pinning, and uses CPU while the game runs |
| Windows built-in dictation | Rejected | Poor accuracy, few languages |
| Azure AI Speech | Not now | Possible later. The same engine interface would take it |

### Requirements for the player

- **Players on the ChatGPT (OpenAI API key) option:** nothing extra beyond turning the feature on and allowing the microphone. The same key, already stored encrypted with DPAPI, is used.
- **Everyone else** (Claude key or subscription, Codex, Gemini, Ollama): an OpenAI API key with billing, pasted once in the voice settings and stored with DPAPI. A ChatGPT Plus or Pro plan doesn't include API access, so Codex players need a separate API key too.
- **An internet connection.** The recording is sent to OpenAI under its API data terms. The settings screen must say so before the feature is turned on.
- **Cost:** OpenAI charges per minute of audio. Questions are capped at 30 s.

### Details to confirm before implementing

- The current transcription model names and prices. As of my knowledge they are `gpt-4o-mini-transcribe`, `gpt-4o-transcribe` and `whisper-1`. Make the model a setting with a sensible default.
- The audio format. Plan: 16 kHz mono 16-bit WAV, about 32 KB per second, so roughly 1 MB at the 30 s cap, well under the API's upload limit.

### Cheap extension

Making the transcription base URL a setting, like the existing OpenAI-compatible chat option, would also cover other services that expose `/v1/audio/transcriptions` (including local servers), at no extra cost. Azure OpenAI needs a different URL layout and an `api-key` header: a small variation. Not part of the first version.

## Pieces to build

| Part | Work |
|---|---|
| Addon | `Bindings.xml` (hold-to-talk), mic button in `UI.lua`, a "listen" variant of `Core:Ask` (no text, "Listening..." placeholder), `ApplyInbox` taking the transcript from the answer, stop message on key up, locale strings |
| Mic helper | `companion/mic/Mic.cs`, compiled on the PC like `tray/Tray.cs`. Records 16 kHz mono through `waveIn`, keeps the microphone closed while idle, detects silence, plays the beep. Controlled by the app over stdin/stdout |
| App | `src/mic.js` (starts and controls the helper), `src/stt.js` (OpenAI transcription), a "listen" branch in `watcher.handleRequest`, voice settings in the window: on/off (off by default), key (reused from ChatGPT when present), model, mic test, privacy text |
| Tests | Lua listen round trip, silence detection on synthetic audio, transcription with a fake `fetch` (request shape, errors, missing key), request authentication |

## Security and privacy

- **Request authentication first (prerequisite).** Chromium on Windows reads text aloud through the same Windows voice system the silent voice plugs into. So a web page can very likely pick the "ForeverAICompanion" voice with `speechSynthesis` and speak a crafted request into the app.
  - Today that means unwanted AI calls on the player's key or plan.
  - With voice questions, it would also mean a web page could open the microphone.
  - Fix: the app writes a random secret into the addon folder at install, the addon includes it in every request, and the app drops requests without it. A web page can't read that folder. This protects the on-screen line too.
  - To confirm the gap: on a PC with invisible sending on, run `speechSynthesis.getVoices().map(v => v.name)` in Chrome's developer console and look for the voice.
- **Off by default.** The microphone opens only on an authenticated listen request and closes right after. Windows shows its mic-in-use indicator. No always-listening mode and no wake word.
- **Audio is never written to disk.** It goes from the helper to the app in memory and is uploaded directly. The transcript is kept like a typed question (chat and log).
- **The API key** is stored encrypted with DPAPI and sent only to the transcription endpoint.
- **Blizzard's rules.** The player presses the key and speaks every question, and answers stay text. Add a row to the README's rules table.

## Out of scope

- Spoken answers. A possible small follow-up: the addon reads answers aloud with the game's own voices, with no app changes.
- Wake word or always-listening mode.
- Voice commands that do things in the game.
- A global Windows hotkey as the trigger. It would start faster, but without fresh character data.

## Phases

0. **Try Windows voice typing (no code).** Press Win+H in the addon's text box. If WoW's edit boxes accept it, players have a basic version today. Unknown whether they do.
1. **Request authentication.** Small.
2. **First version.** Listen flow, mic helper, OpenAI transcription, settings, tests. Medium.
3. **Later.** Tuning the vocabulary hints, a configurable endpoint, Azure, spoken answers.

## Risks to measure early

- **Start delay.** About 0.5 to 1 s passes between the key press and recording starting. The beep covers it. With the on-screen line it's slower and the line is visible, so voice questions should require invisible sending.
- **Answer delay.** Upload plus transcription adds about 1 to 2 s before the AI starts answering.
- **Windows microphone privacy setting.** "Let desktop apps access your microphone" must be on. Detect it and explain.
- **Key-up keybindings.** Confirm the WoW Forever client supports bindings that fire on key release.
- **Accuracy** of WoW names and Spanish, with and without vocabulary hints.

## Open decisions

1. OpenAI only for the first version? (Proposed.)
2. Require invisible sending for voice questions? (Proposed: yes.)
3. Ship request authentication first? (Proposed: yes.)
4. Spoken answers: later?
