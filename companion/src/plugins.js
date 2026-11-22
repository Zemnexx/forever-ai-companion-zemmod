// Plugins: other addons that ask through Forever AI Companion (Plugins.lua
// in the addon). A request carries req.ext = { name, kind, input }; the
// plugin registered here under that name answers it with data for its addon.
//
// Only plugins listed here run. What a plugin tells the AI is written in this
// app (never taken from the request), so a request can only choose among the
// things a plugin knows how to do.
//
// A plugin: { name, handle(req, env) -> Promise<{ text, data, model, usage }> }
//   env: { cfg, log, lang, guides, knowledge }
//   text: one or two sentences for the app's list of questions (and the
//         addon's status line); data: a plain object for the plugin's addon.
import { createArmory } from './armory/index.js';

export function createPlugins(options = {}) {
  const armory = createArmory(options.armory);
  return { [armory.name]: armory };
}
