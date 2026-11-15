// Codex (ChatGPT Plus / Pro plan) as the AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPreset, loadConfig } from '../src/config.js';
import {
  CODEX_DISABLE, CODEX_MUST_DISABLE, codexArgs, friendlyCodexError, parseCodexEvents, parseLoginStatus, rejectedCodexFeatures, shellQuote,
} from '../src/codex.js';
import { ask, callWithoutFeatures, canSearch } from '../src/providers.js';
import { runInLang } from '../src/i18n.js';

test('Codex runs as a plain chat model with our instructions', () => {
  const args = codexArgs({ model: 'gpt-6-luna', effort: 'low' }, {
    instructionsFile: 'C:\\Users\\Ana Pérez\\tmp\\sys.txt', outFile: 'C:\\tmp\\out.txt', workDir: 'C:\\tmp', webSearch: true,
  });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'exec');
  for (const f of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) assert.ok(args.includes(f), f);
  assert.equal(after('--sandbox'), 'read-only');
  assert.equal(after('--model'), 'gpt-6-luna');
  assert.equal(after('--output-last-message'), 'C:\\tmp\\out.txt');
  const configs = args.filter((_, i) => args[i - 1] === '-c');
  // Our prompt replaces Codex's coding instructions (TOML literal, forward slashes).
  assert.ok(configs.includes("model_instructions_file='C:/Users/Ana Pérez/tmp/sys.txt'"));
  assert.ok(configs.includes("web_search='live'"));
  assert.ok(configs.includes('project_doc_max_bytes=0'));
  assert.ok(configs.includes("model_reasoning_effort='low'"));
  for (const f of ['shell_tool', 'unified_exec', 'apps', 'plugins']) assert.ok(CODEX_DISABLE.includes(f));
  assert.equal(args.at(-1), '-', 'the question goes in on stdin');

  const plain = codexArgs({ model: 'default' }, { instructionsFile: 'a', outFile: 'b', workDir: 'c', webSearch: false, disable: [] });
  assert.ok(!plain.includes('--model'), '"default" lets the plan choose');
  assert.ok(plain.includes("web_search='disabled'"));
  assert.ok(!plain.includes('--disable'));
  // cmd.exe (codex.cmd) needs quotes around arguments with spaces.
  assert.deepEqual(shellQuote(['a', "x='C:/Ana Pérez'"]), ['a', "\"x='C:/Ana Pérez'\""]);
});

test('Codex events: answer, failures and sign-in', () => {
  const ok = parseCodexEvents([
    '{"type":"thread.started","thread_id":"t"}',
    'WARNING: not json',
    '{"type":"item.completed","item":{"id":"1","type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"id":"2","type":"agent_message","text":"Ve a Minas de la Muerte."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
  ].join('\n'));
  assert.equal(ok.text, 'Ve a Minas de la Muerte.');
  assert.equal(ok.error, null);
  assert.equal(ok.usage.output_tokens, 5);

  const bad = parseCodexEvents([
    '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized)"}',
    '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}',
  ].join('\n'));
  assert.match(bad.error, /401/);
  assert.match(runInLang('en', () => friendlyCodexError(bad.error)), /Sign in/);
  assert.match(runInLang('en', () => friendlyCodexError("You've hit your usage limit")), /usage limit/);
  assert.match(runInLang('es', () => friendlyCodexError(bad.error)), /Iniciar sesión/);

  assert.deepEqual(parseLoginStatus('Not logged in'), { loggedIn: false, method: null });
  assert.deepEqual(parseLoginStatus('Logged in using ChatGPT'), { loggedIn: true, method: 'chatgpt' });
});

test('the ChatGPT plan option can search the web', () => {
  const cfg = applyPreset({ ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), preset: 'codex', models: { codex: 'gpt-6-astra' } });
  assert.equal(cfg.provider, 'codex');
  assert.equal(cfg.codex.model, 'gpt-6-astra');
  assert.equal(canSearch(cfg), true);
  assert.equal(canSearch({ ...cfg, webSearch: false }), false);
});

// A stand-in for codex: records how it was called and answers like Codex does.
const FAKE = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const log = process.env.FAKE_CODEX_LOG;
if (args[0] === 'login') { console.log(process.env.FAKE_CODEX_LOGIN || 'Logged in using ChatGPT'); process.exit(process.env.FAKE_CODEX_LOGIN ? 1 : 0); }
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const val = (f) => args[args.indexOf(f) + 1];
  const cfgs = args.filter((_, i) => args[i - 1] === '-c');
  const instr = cfgs.find((c) => c.startsWith('model_instructions_file=')).slice(25, -1);
  const system = fs.readFileSync(instr, 'utf8');
  fs.writeFileSync(log, JSON.stringify({ args, stdin, system }));
  if (process.env.FAKE_CODEX_FAIL) {
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: process.env.FAKE_CODEX_FAIL } }));
    process.exit(1);
  }
  fs.writeFileSync(val('--output-last-message'), 'Respuesta de Codex');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Respuesta de Codex' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
});
`;

test('asking through Codex end to end (fake codex in a folder with spaces)', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake codex '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'fake-codex.mjs'), FAKE);
  const bin = path.join(dir, 'codex.cmd');
  fs.writeFileSync(bin, '@node "%~dp0fake-codex.mjs" %*\r\n');
  const logFile = path.join(dir, 'call.json');
  process.env.FAKE_CODEX_LOG = logFile;
  t.after(() => { delete process.env.FAKE_CODEX_LOG; delete process.env.FAKE_CODEX_FAIL; delete process.env.FAKE_CODEX_LOGIN; });

  const cfg = applyPreset({ ...loadConfig(path.join(dir, 'none.json')), preset: 'codex', timeoutMs: 30000 });
  cfg.codex = { ...cfg.codex, bin };
  const messages = [{ role: 'user', content: '¿Qué hago ahora?' }];
  const r = await ask(cfg, 'Eres Fizzi.', messages, {});
  assert.equal(r.text, 'Respuesta de Codex');
  assert.match(r.model, /suscripción/);
  const call = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.match(call.system, /^Eres Fizzi\./, 'our prompt reached Codex as its instructions');
  assert.match(call.system, /Do not run commands/);
  assert.match(call.stdin, /¿Qué hago ahora\?/);
  assert.ok(call.args.includes("web_search='live'"));

  process.env.FAKE_CODEX_FAIL = "You've hit your usage limit. Try again later.";
  await assert.rejects(runInLang('en', () => ask(cfg, 'Eres Fizzi.', messages, {})), /usage limit/);
  // Inside a Spanish player's request, the same error is in Spanish.
  await assert.rejects(runInLang('es', () => ask(cfg, 'Eres Fizzi.', messages, {})), /límite de uso de tu plan/);
});

test('a Codex that no longer knows a feature: only that one is dropped, never the safety ones', async () => {
  const unknown = (name) => Object.assign(new Error('codex exited with 2'), { stderr: `Error: unknown feature \`${name}\`` });
  const fakeCodex = (rejects) => {
    const calls = [];
    return { calls, call: async (list) => { calls.push(list); const bad = list.find((f) => rejects.includes(f)); if (bad) throw unknown(bad); return 'ok'; } };
  };
  const a = fakeCodex(['goals', 'tool_suggest']);
  assert.equal(await callWithoutFeatures(a.call), 'ok');
  const last = a.calls.at(-1);
  assert.ok(!last.includes('goals') && !last.includes('tool_suggest'));
  for (const f of CODEX_MUST_DISABLE) assert.ok(last.includes(f), `${f} still turned off`);
  assert.equal(last.length, CODEX_DISABLE.length - 2, 'nothing else was dropped');

  // Codex stops accepting shell_tool (renamed?): no retry with commands possibly on.
  const b = fakeCodex(['shell_tool']);
  await assert.rejects(runInLang('en', () => callWithoutFeatures(b.call)), /safety setting.*shell_tool/);
  assert.equal(b.calls.length, 1);
  // An "unknown feature" error that names nothing we sent: fail closed too.
  await assert.rejects(runInLang('en', () => callWithoutFeatures(async () => { throw Object.assign(new Error('x'), { stderr: 'unknown feature flags in config' }); })), /safety setting/);
  // Other errors pass through untouched.
  await assert.rejects(callWithoutFeatures(async () => { throw new Error('usage limit'); }), /usage limit/);
  assert.equal(rejectedCodexFeatures('all good'), null);
  assert.deepEqual(rejectedCodexFeatures("error: unknown feature 'image_generation'"), ['image_generation']);
});
