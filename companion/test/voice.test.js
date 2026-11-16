// Invisible voice channel: the addon's base64 + chunking (real Lua) and the
// app's reassembly must round-trip a request exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLua } from './helpers.js';
import { createAssembler, startVoiceInbox } from '../src/voice-inbox.js';
import { ttsEngineSource } from '../src/assets.js';
import {
  ENGINE_CLASS, ENGINE_CLSID, ENGINE_DLL, LEGACY_ENGINE_CLASS, LEGACY_ENGINE_DLL, LEGACY_VOICE_NAME, VOICE_NAME,
  elevatedBootstrap, elevatedScript, isLegacyEngine, machineDll, machineEngineVerdict, machineRegFile, machineUnregFile, psQuote,
} from '../src/tts-voice.js';

test('Lua base64 matches the standard encoding', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'hola ñandú {"x":1}', '\u0000ÿ\u0010binario']) {
    const out = runLua('RESULT = ns.Voice.Base64(S)', { S: s }, ['Voice.lua']);
    assert.equal(out, Buffer.from(s, 'utf8').toString('base64'), JSON.stringify(s));
  }
});

test('a request spoken in chunks by the addon is reassembled by the app', () => {
  const out = runLua(`
    SPOKEN = {}
    C_VoiceChat = {
      GetTtsVoices = function() return { { voiceID = 0, name = "Microsoft Zira Desktop - English (United States)" },
                                         { voiceID = 3, name = "ForeverAICompanion - English (United States)" } } end,
      SpeakText = function(id, text, rate, volume, overlap)
        assert(id == 3, "wrong voice"); assert(overlap == true, "must queue"); assert(volume == 0, "must be silent")
        SPOKEN[#SPOKEN + 1] = text
      end,
    }
    assert(ns.Voice:Available())
    local parts = {}
    for i = 1, 400 do parts[i] = '{"quest":"Misión ' .. i .. ' ñ","n":' .. i .. '}' end
    local json = '{"id":"v1","question":"¿Me oyes?","context":{"quests":[' .. table.concat(parts, ",") .. ']}}'
    local frame = ns.Uplink.Frame(json)
    -- A typical request fits in one silent phrase with the default settings.
    assert(ns.Voice:Send(frame, "v0"))
    assert(#SPOKEN == 1, "expected a single phrase, got " .. #SPOKEN)
    SPOKEN = {}
    -- Small chunks to exercise multi-part reassembly.
    ns.Voice.CHUNK = 1000
    assert(ns.Voice:Send(frame, "v1"))
    RESULT = json .. "\\0" .. table.concat(SPOKEN, "\\0")
  `, {}, ['Json.lua', 'Uplink.lua', 'Voice.lua']);
  const [json, ...spoken] = out.split('\0');
  assert.ok(spoken.length > 1, 'should be split in several messages');
  for (const s of spoken) assert.ok(s.length <= 1000 + 20);
  for (const s of spoken) assert.match(s, /^FAIC:v1:\d+\/\d+:/);
  assert.equal(Buffer.from(spoken[0].split(':')[3], 'base64').toString('latin1', 0, 4), 'FAIC', 'frame mark');
  const asm = createAssembler();
  // Arrival order does not matter; foreign texts are ignored.
  assert.equal(asm.add('Hola, esto lo lee el chat'), null);
  let payload = null;
  for (const s of [...spoken].reverse()) payload = asm.add(s) || payload;
  assert.ok(payload);
  assert.equal(payload.toString('utf8'), json);
});

// Every phrase makes Windows open the sound output (a faint "pop" on some PCs),
// so a normal question must go in one phrase, and none may pass the game's cut.
test('a real-sized question is one phrase, and no phrase reaches the game\'s cut', () => {
  const GAME_CUT = 29997; // measured in WoW Forever: a 64 000-character phrase arrives with this many
  const out = runLua(`
    SPOKEN = {}
    C_VoiceChat = {
      GetTtsVoices = function() return { { voiceID = 3, name = "ForeverAICompanion" } } end,
      SpeakText = function(id, text) SPOKEN[#SPOKEN + 1] = #text end,
    }
    assert(ns.Voice:Available())
    local function ask(base64Chars)
      SPOKEN = {}
      -- Random-ish bytes: base64 makes 4 characters of every 3 bytes.
      local bytes = {}
      for i = 1, math.floor(base64Chars * 3 / 4) do bytes[i] = string.char((i * 37) % 256) end
      assert(ns.Voice:Send(table.concat(bytes), "17946751069423"))
      return #SPOKEN .. ":" .. math.max(table.unpack(SPOKEN))
    end
    -- Sizes seen in the game: 12 800 to 17 800 characters; the largest frame allowed.
    RESULT = ask(17800) .. "," .. ask(23900) .. "," .. ask(ns.Voice.MAX_FRAME_BYTES * 4 / 3)
  `, {}, ['Json.lua', 'Uplink.lua', 'Voice.lua']);
  const [normal, big, max] = out.split(',').map((s) => s.split(':').map(Number));
  assert.equal(normal[0], 1, 'a normal question is a single phrase');
  assert.equal(big[0], 1);
  assert.ok(max[0] > 1);
  for (const [, longest] of [normal, big, max]) assert.ok(longest < GAME_CUT - 4000, `phrase of ${longest} characters`);
});

test('messages wrapped in the game\'s "Start"/"End" bookmarks still reassemble', () => {
  const out = runLua(`
    SPOKEN = {}
    C_VoiceChat = {
      GetTtsVoices = function() return { { voiceID = 3, name = "ForeverAICompanion - English (United States)" } } end,
      SpeakText = function(id, text) SPOKEN[#SPOKEN + 1] = text end,
    }
    assert(ns.Voice:Available())
    local json = '{"id":"w1","question":"' .. string.rep("¿Gnomeregan? ", 300) .. '"}'
    assert(ns.Voice:Send(ns.Uplink.Frame(json), "w1"))
    RESULT = json .. "\\0" .. table.concat(SPOKEN, "\\0")
  `, {}, ['Json.lua', 'Uplink.lua', 'Voice.lua']);
  const [json, ...spoken] = out.split('\0');
  const asm = createAssembler();
  let payload = null;
  // Exactly what the app logged from WoW: "Start" before, "End" after.
  for (const s of spoken) payload = asm.add(`Start${s}End`) || payload;
  assert.ok(payload);
  assert.equal(payload.toString('utf8'), json);
});

test('without the silent voice the addon falls back to the strip', () => {
  const out = runLua(`
    C_VoiceChat = { GetTtsVoices = function() return { { voiceID = 0, name = "Microsoft Zira Desktop" } } end }
    RESULT = tostring(ns.Voice:Available())
  `, {}, ['Voice.lua']);
  assert.equal(out, 'false');
});

test('the voice is called ForeverAICompanion; the one from before the rename is replaced', () => {
  assert.equal(VOICE_NAME, 'ForeverAICompanion');
  const reg = machineRegFile();
  assert.match(reg, new RegExp(`\\[-HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Microsoft\\\\Speech\\\\Voices\\\\Tokens\\\\${LEGACY_VOICE_NAME}\\]`), 'installing removes the old token');
  assert.match(reg, /\[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\ForeverAICompanion\]/);
  assert.match(reg, /"Name"="ForeverAICompanion"/);
  // Same class id; the old registration is cleared and the current engine registered.
  const clsid = ENGINE_CLSID.replace(/[{}]/g, '\\$&');
  assert.ok(reg.indexOf(`[-HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\${ENGINE_CLSID}]`) <
    reg.indexOf(`[HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\${ENGINE_CLSID}]`), 'cleared before registering');
  assert.match(reg, new RegExp(`CLSID\\\\${clsid}\\]\\r\\n@="ForeverAICompanion\\.Tts\\.Engine"`));
  assert.match(reg, /"Class"="ForeverAICompanion\.Tts\.Engine"/);
  assert.match(reg, /"Assembly"="ForeverAICompanionTts, Version=1\.0\.0\.0/);
  // Elevated programs load this copy: it lives in the admin-only folder, never the user's.
  assert.match(reg, /"CodeBase"="file:\/\/\/C:\/Program Files\/ForeverAICompanion\/ForeverAICompanionTts\.dll"/);
  assert.doesNotMatch(reg, /AppData/i);
  assert.ok(!reg.includes(LEGACY_ENGINE_CLASS) && !reg.includes(LEGACY_ENGINE_DLL));
  const unreg = machineUnregFile();
  assert.match(unreg, /Tokens\\ForeverAICompanion\]/);
  assert.ok(unreg.includes(`Tokens\\${LEGACY_VOICE_NAME}]`), 'uninstalling also removes the old name');

  // The C# engine's names match what gets registered, with the same class id.
  const cs = ttsEngineSource();
  assert.match(cs, /namespace ForeverAICompanion\.Tts/);
  assert.match(cs, /public class Engine\b/);
  assert.ok(cs.includes(`Guid("${ENGINE_CLSID.replace(/[{}]/g, '')}")`));
  assert.equal(ENGINE_CLASS, 'ForeverAICompanion.Tts.Engine');
  assert.equal(ENGINE_DLL, 'ForeverAICompanionTts.dll');

  // The addon prefers the new voice and still works with the old one.
  const pick = (names) => runLua(`
    C_VoiceChat = { GetTtsVoices = function() local l = {} for i, n in ipairs(NAMES) do l[i] = { voiceID = i, name = n } end return l end }
    RESULT = tostring(ns.Voice:Find())`, {}, ['Voice.lua'], `NAMES = { ${names.map((n) => JSON.stringify(n)).join(', ')} }`);
  assert.equal(pick(['Microsoft Zira', `${LEGACY_VOICE_NAME} - English`, 'ForeverAICompanion - English']), '3');
  assert.equal(pick(['Microsoft Zira', `${LEGACY_VOICE_NAME} - English`]), '2');
  assert.equal(pick(['Microsoft Zira']), 'nil');
});

test('an engine registered before the rename is reported as needing the update', () => {
  const programs = 'C:/Users/x/AppData/Local/Programs';
  assert.equal(isLegacyEngine({ className: LEGACY_ENGINE_CLASS, codeBase: `file:///${programs}/${LEGACY_VOICE_NAME}/${LEGACY_ENGINE_DLL}` }), true);
  assert.equal(isLegacyEngine({ className: null, codeBase: `file:///${programs}/${LEGACY_VOICE_NAME}/${LEGACY_ENGINE_DLL}` }), true, 'old DLL alone');
  assert.equal(isLegacyEngine({ className: LEGACY_ENGINE_CLASS, codeBase: null }), true, 'old class alone');
  assert.equal(isLegacyEngine({ className: ENGINE_CLASS, codeBase: `file:///${programs}/ForeverAICompanion/${ENGINE_DLL}` }), false);
  assert.equal(isLegacyEngine(null), false);
});

test('the app reads the voice inbox and, while it exists, the one from before the rename', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-voice-'));
  const dir = path.join(root, 'ForeverAICompanion', 'tts-inbox');
  const legacyDir = path.join(root, LEGACY_VOICE_NAME, 'tts-inbox');
  const missing = path.join(root, 'nowhere', 'tts-inbox');
  const frameText = (id, json, prefix) => {
    const b64 = runLua('RESULT = ns.Voice.Base64(ns.Uplink.Frame(J))', { J: json }, ['Json.lua', 'Uplink.lua', 'Voice.lua']);
    return `${prefix}:${id}:1/1:${b64}`;
  };
  const got = [];
  const inbox = startVoiceInbox({ dir, legacyDirs: [legacyDir, missing], intervalMs: 1000000, onPayload: (p) => got.push(p.toString('utf8')) });
  try {
    assert.ok(fs.existsSync(dir));
    assert.ok(!fs.existsSync(legacyDir) && !fs.existsSync(missing), 'the old inbox is never created by the app');
    fs.writeFileSync(path.join(dir, '1.txt'), frameText('n1', '{"id":"n1"}', 'FAIC'));
    inbox.poll();
    // The previous voice recreates its folder; an old addon still uses the old prefix and frame mark.
    fs.mkdirSync(legacyDir, { recursive: true });
    const oldFrame = Buffer.from(frameText('o1', '{"id":"o1"}', 'FAIC').split(':')[3], 'base64');
    oldFrame.write('AZIA', 0, 'latin1');
    fs.writeFileSync(path.join(legacyDir, '2.txt'), `AZIA:o1:1/1:${oldFrame.toString('base64')}`);
    inbox.poll();
    assert.deepEqual(got, ['{"id":"n1"}', '{"id":"o1"}']);
    assert.deepEqual(fs.readdirSync(legacyDir), [], 'read messages are removed');
  } finally {
    inbox.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('the machine-wide engine is an admin-only, hash-checked copy', () => {
  const script = elevatedScript({ mode: 'install', sourceDll: 'C:\\Users\\O’Brien\\AppData\\Local\\Programs\\ForeverAICompanion\\ForeverAICompanionTts.dll', dllSha256: 'AB'.repeat(32), sourceHash: 'cd'.repeat(32) });
  assert.match(script, /icacls\.exe'\) \$dir \/inheritance:r \/grant:r '\*S-1-5-32-544:\(OI\)\(CI\)F' '\*S-1-5-18:\(OI\)\(CI\)F' '\*S-1-5-32-545:\(OI\)\(CI\)RX'/, 'users can only read and run it');
  assert.match(script, /Get-FileHash -LiteralPath \$new -Algorithm SHA256\)\.Hash -ne '(AB){32}'\) \{[^}]*exit 22 \}/, 'the copy is checked before it is used');
  assert.ok(script.indexOf('exit 22') < script.indexOf("reg.exe') import"), 'registered only after the check');
  assert.match(script, /if \(IsLink \$dir\) \{ exit 21 \}/, 'never through a link');
  assert.ok(script.includes("'C:\\Users\\O’’Brien\\"), 'typographic quotes cannot end the literal');
  assert.ok(script.includes('ForeverAICompanionTts.dll.source-sha256') || script.includes('$dll.source-sha256'));
  assert.match(script, /"CodeBase"="file:\/\/\/C:\/Program Files\/ForeverAICompanion\/ForeverAICompanionTts\.dll"/);
  assert.equal(psQuote("a'b‘c"), "'a''b‘‘c'");

  const un = elevatedScript({ mode: 'uninstall' });
  assert.match(un, /delete 'HKLM\\SOFTWARE\\Classes\\CLSID\\\{DE6988DD/);
  assert.match(un, /Remove-Item -LiteralPath \$dir -Recurse/);

  // The UAC launch stays under ShellExecuteEx's ~2048 character limit and runs only the bytes it hashed.
  const boot = elevatedBootstrap('C:\\Users\\Ana Pérez Rodríguez\\AppData\\Roaming\\ForeverAICompanion\\forever-ai-companion-voice-1731700000000.ps1', 'f'.repeat(64));
  assert.ok(boot.length < 1800, `bootstrap is ${boot.length} characters`);
  const decoded = Buffer.from(boot, 'base64').toString('utf16le');
  assert.match(decoded, /ReadAllBytes/);
  assert.match(decoded, /if\(\$h -ne 'f{64}'\)\{exit 30\}/);
  assert.match(decoded, /ScriptBlock\]::Create\(\[Text\.Encoding\]::UTF8\.GetString\(\$b\)\)/);
});

test('installs that registered the user-folder DLL machine-wide are offered the update', () => {
  const marker = (v) => () => v;
  const none = () => { throw new Error('missing'); };
  const prot = `file:///${machineDll().replace(/\\/g, '/')}`;
  const userCopy = 'file:///C:/Users/x/AppData/Local/Programs/ForeverAICompanion/ForeverAICompanionTts.dll';
  assert.equal(machineEngineVerdict({ codeBase: userCopy }, { sourceHash: 'h1', readMarker: marker('h1') }), 'outside');
  assert.equal(machineEngineVerdict({ codeBase: prot }, { sourceHash: 'h1', readMarker: marker('h1\n') }), 'ok');
  assert.equal(machineEngineVerdict({ codeBase: prot.toUpperCase().replace('FILE:', 'file:') }, { sourceHash: 'h1', readMarker: marker('h1') }), 'ok', 'paths compare case-insensitively');
  assert.equal(machineEngineVerdict({ codeBase: prot }, { sourceHash: 'h2', readMarker: marker('h1') }), 'stale');
  assert.equal(machineEngineVerdict({ codeBase: prot }, { sourceHash: 'h2', readMarker: none }), 'stale');
  assert.equal(machineEngineVerdict(null, { sourceHash: 'h1', readMarker: none }), 'none');
});

test('the voice only keeps the app\'s own messages and never logs what others speak', async () => {
  const cs = ttsEngineSource();
  assert.match(cs, /if \(!IsOurs\(all\)\) return 0;/, 'foreign text is dropped before anything is written');
  assert.doesNotMatch(cs, /Substring\(0, 24\)/, 'no spoken text in the engine log');
  assert.match(cs, /FileAttributes\.ReparsePoint/, 'no writes through planted links');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-voice-'));
  const dir = path.join(root, 'tts-inbox');
  const logs = [];
  const inbox = startVoiceInbox({ dir, legacyDirs: [], intervalMs: 1000000, onPayload: () => {}, log: (m) => logs.push(m) });
  try {
    fs.writeFileSync(path.join(dir, '1.txt'), 'Your bank PIN is 4321, reading it aloud');
    fs.writeFileSync(path.join(dir, '2.txt'), 'FAIC-VOICE-TEST volume0 1731700000');
    inbox.poll();
    assert.ok(!logs.some((l) => /PIN|4321|aloud/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /Voice test received/.test(l)), 'the addon\'s own voice test still shows up');
    assert.deepEqual(fs.readdirSync(dir), [], 'everything read is removed');
  } finally {
    inbox.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the per-user voice is checked against this copy of the app', async () => {
  const { codeBaseIs } = await import('../src/tts-voice.js');
  const here = 'C:\\Users\\Tyler\\AppData\\Local\\Programs\\ForeverAICompanion\\ForeverAICompanionTts.dll';
  assert.equal(codeBaseIs('file:///C:/Users/Tyler/AppData/Local/Programs/ForeverAICompanion/ForeverAICompanionTts.dll', here), true);
  assert.equal(codeBaseIs('file:///c:/users/tyler/appdata/local/programs/foreveraicompanion/foreveraicompaniontts.dll', here), true, 'case does not matter on Windows');
  assert.equal(codeBaseIs('file:///C:/Users/Tyler/AppData/Local/FAIC-test/app/ForeverAICompanionTts.dll', here), false, 'another install folder');
  assert.equal(codeBaseIs(null, here), false);
  assert.equal(codeBaseIs('file:///C:/x.dll', null), false);
});
