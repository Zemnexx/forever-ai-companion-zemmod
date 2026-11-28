// How each provider treats a long answer: whether it says the output limit
// cut it off, how a long one is asked for, and that chat questions are asked
// exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LONG_ANSWER_TOKENS, ask, askClaudeApi, claudeCodeEnv } from '../src/providers.js';
import { runInLang } from '../src/i18n.js';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { armoryConfig, armoryPatch, lookupConfig } from '../src/armory/index.js';

// A stand-in for the Anthropic SDK: the same error classes the provider
// checks, and messages.create / messages.stream (and the beta ones) that
// answer from a script and record how they were called.
class APIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class AuthenticationError extends APIError {}
class PermissionDeniedError extends APIError {}
class RateLimitError extends APIError {}
class BadRequestError extends APIError {}
class APIUserAbortError extends APIError { constructor() { super(undefined, 'Request was aborted.'); } }
class APIConnectionTimeoutError extends APIError { constructor() { super(undefined, 'Request timed out.'); } }
const ERRORS = { APIError, AuthenticationError, PermissionDeniedError, RateLimitError, BadRequestError, APIUserAbortError, APIConnectionTimeoutError };

function fakeSdk(...replies) {
  const calls = [];
  const next = async (how, body, options) => {
    calls.push({ how, body, options });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return structuredClone(reply);
  };
  const api = (prefix) => ({
    create: (body, options) => next(`${prefix}create`, body, options),
    // Like the SDK's, stream() returns at once and finalMessage() settles.
    stream: (body, options) => ({ finalMessage: () => next(`${prefix}stream`, body, options) }),
  });
  class Anthropic {
    constructor() {
      this.messages = api('');
      this.beta = { messages: api('beta.') };
    }
  }
  Object.assign(Anthropic, ERRORS);
  return { Anthropic, calls };
}

const message = (text, stop = 'end_turn', extra = {}) => ({
  model: 'claude-opus-5-5', stop_reason: stop, content: [{ type: 'text', text }],
  usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 7 }, ...extra,
});
const claudeCfg = (maxTokens, extra = {}) => ({
  ...DEFAULTS, provider: 'anthropic', webSearch: false, timeoutMs: 1000,
  anthropic: { ...DEFAULTS.anthropic, maxTokens, fallbacks: false, ...extra },
});
const messages = [{ role: 'user', content: 'hi' }];

test('Claude API: a chat question is sent whole, as before, and a cut-off one says so', async () => {
  const sdk = fakeSdk(message('Go to the Deadmines.'));
  const out = await askClaudeApi(sdk.Anthropic, claudeCfg(2000), 'system', messages);
  assert.deepEqual(out, { text: 'Go to the Deadmines.', model: 'claude-opus-5-5', usage: { input: 15, cached: 5, output: 7 } });
  assert.equal(sdk.calls[0].how, 'create');
  assert.equal(sdk.calls[0].body.max_tokens, 2000);
  assert.deepEqual(sdk.calls[0].options, { timeout: 1000 }, 'no deadline of its own: exactly as before');

  const cut = await askClaudeApi(fakeSdk(message('Go to the', 'max_tokens')).Anthropic, claudeCfg(2000), 'system', messages);
  assert.equal(cut.text, 'Go to the [...]', 'the chat still shows it was cut');
  assert.equal(cut.truncated, true);
});

test('Claude API: a long answer is streamed, with the same result as a whole one', async () => {
  const whole = fakeSdk(message('{"a":1}', 'max_tokens'));
  const streamed = fakeSdk(message('{"a":1}', 'max_tokens'));
  const a = await askClaudeApi(whole.Anthropic, claudeCfg(LONG_ANSWER_TOKENS), 'system', messages);
  const b = await askClaudeApi(streamed.Anthropic, claudeCfg(64000), 'system', messages);
  assert.equal(whole.calls[0].how, 'create', 'at the threshold: sent whole');
  assert.equal(streamed.calls[0].how, 'stream', 'above it: streamed');
  assert.deepEqual(b, a);
  assert.equal(b.truncated, true);
  assert.equal(streamed.calls[0].body.max_tokens, 64000);
  assert.equal(streamed.calls[0].options.timeout, 1000);
  assert.ok(streamed.calls[0].options.signal instanceof AbortSignal, 'the whole answer has a deadline');
  assert.deepEqual({ ...whole.calls[0].body }, { ...streamed.calls[0].body, max_tokens: LONG_ANSWER_TOKENS }, 'the same request otherwise');
});

test('Claude API streamed: web tools, a paused turn, the fallback beta, usage, refusals and errors as before', async () => {
  // Web search on, a fallback model: the beta path, and a paused turn resumed.
  const sdk = fakeSdk(message('', 'pause_turn'), message('Done.'));
  const cfg = { ...claudeCfg(64000, { fallbacks: true }), webSearch: true };
  const out = await askClaudeApi(sdk.Anthropic, cfg, 'system', messages);
  assert.deepEqual(sdk.calls.map((c) => c.how), ['beta.stream', 'beta.stream']);
  assert.deepEqual(sdk.calls[0].body.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(sdk.calls[0].body.fallbacks, 'default');
  assert.deepEqual(sdk.calls[0].body.tools.map((t) => t.name), ['web_search', 'web_fetch']);
  assert.equal(sdk.calls[1].body.messages.at(-1).role, 'assistant', 'the paused turn is sent back');
  assert.deepEqual(out.usage, { input: 30, cached: 10, output: 14 }, 'both rounds counted');
  assert.equal(out.text, 'Done.');
  assert.equal('truncated' in out, false);

  await runInLang('en', async () => {
    await assert.rejects(askClaudeApi(fakeSdk(message('', 'refusal')).Anthropic, claudeCfg(64000), 's', messages), /declined to answer/);
    await assert.rejects(askClaudeApi(fakeSdk(new BadRequestError(400, 'nope')).Anthropic, claudeCfg(64000), 's', messages), /The API rejected the request: nope/);
    await assert.rejects(askClaudeApi(fakeSdk(new AuthenticationError(401, 'x')).Anthropic, claudeCfg(64000), 's', messages), /Claude key is not valid/);
    // A stream stopped by its deadline reads as a timeout, as a whole request's would.
    const aborted = fakeSdk(new APIUserAbortError());
    await assert.rejects(askClaudeApi(aborted.Anthropic, claudeCfg(64000), 's', messages), /Anthropic API error \(network\): Request timed out\./);
  });
});

test('OpenAI-compatible: an answer ended by the length limit says so; no limit is sent', async (t) => {
  const bodies = [];
  const reply = (finish) => ({ model: 'gpt-5-mini', choices: [{ message: { content: '{"a":' }, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  let finish = 'length';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(reply(finish)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const cfg = { ...DEFAULTS, provider: 'openai', timeoutMs: 1000, openai: { ...DEFAULTS.openai, apiKey: 'k' } };
  const cut = await ask(cfg, 'system', messages, {});
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, '{"a":', 'the text as the server sent it');
  finish = 'stop';
  const whole = await ask(cfg, 'system', messages, {});
  assert.equal('truncated' in whole, false);
  assert.equal(bodies[0].max_tokens, undefined);
  assert.equal(bodies[0].max_completion_tokens, undefined);
});

test('Claude Code is told a long answer\'s limit, and nothing for a chat question', () => {
  assert.deepEqual(claudeCodeEnv({ maxTokens: 64000 }), { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' });
  assert.equal(claudeCodeEnv({ maxTokens: LONG_ANSWER_TOKENS }), null);
  assert.equal(claudeCodeEnv(DEFAULTS.claudeCode), null);
  assert.equal(claudeCodeEnv(armoryConfig({ ...DEFAULTS, provider: 'claude-code' }).claudeCode).CLAUDE_CODE_MAX_OUTPUT_TOKENS, '64000');
  assert.equal(claudeCodeEnv(lookupConfig({ ...DEFAULTS, provider: 'claude-code' }).claudeCode), null, 'the short id lookup is not');
});

test('the Armory\'s room for an answer: 64000 by default, and saving its settings never stores a limit', () => {
  assert.equal(DEFAULTS.armory.maxTokens, 64000);
  assert.equal(DEFAULTS.anthropic.maxTokens, 2000, 'the chat keeps its own');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-limit-'));
  const file = path.join(dir, 'config.json');
  // What the app's Armory settings write: how thorough and the model, no limit.
  const patch = armoryPatch({ ...DEFAULTS, preset: 'claude' }, { effort: 'medium', model: 'claude-opus-5-5' });
  assert.deepEqual(Object.keys(patch.armory).sort(), ['effort', 'models']);
  fs.writeFileSync(file, JSON.stringify(patch));
  const cfg = loadConfig(file);
  assert.equal(cfg.armory.maxTokens, 64000, 'a saved file without it gets the new default');
  assert.equal(armoryConfig(cfg).anthropic.maxTokens, 64000);
  assert.equal(armoryConfig(cfg).anthropic.effort, 'medium');
});
