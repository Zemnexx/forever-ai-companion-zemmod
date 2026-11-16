// Tokens each answer used, shown in the game (see watcher.js and the addon's UI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCodeArgs, claudeCodeUsage, tokenUsage } from '../src/providers.js';

test('token usage: Claude Code adds up every model call, cached input included', () => {
  const json = {
    usage: { input_tokens: 2, cache_read_input_tokens: 649, cache_creation_input_tokens: 3120, output_tokens: 24 },
    modelUsage: {
      'claude-sonnet-5-5': { inputTokens: 10, cacheReadInputTokens: 9000, cacheCreationInputTokens: 3000, outputTokens: 200 },
      'claude-haiku-5-5': { inputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 20 },
    },
  };
  assert.deepEqual(claudeCodeUsage(json), { input: 12015, cached: 9000, output: 220 });
  assert.deepEqual(claudeCodeUsage({ usage: json.usage }), { input: 3771, cached: 649, output: 24 }, 'older Claude Code without modelUsage');
  assert.equal(claudeCodeUsage({}), null);
  assert.deepEqual(tokenUsage('7', undefined, -3), { input: 7, cached: 0, output: 0 });
});

test('Claude Code gets only web search: no files, commands or other tools', () => {
  const cc = claudeCodeArgs({ model: 'sonnet' }, 'sys.txt', false, { webSearch: true });
  assert.deepEqual(cc.slice(cc.indexOf('--tools'), cc.indexOf('--tools') + 4), ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch']);
  assert.ok(cc.includes('--strict-mcp-config') && !cc.includes('--mcp-config'));
});
