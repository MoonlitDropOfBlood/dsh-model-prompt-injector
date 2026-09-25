/**
 * Behavioral test of the rule-delivery state machine (index.js) against stubbed
 * host packages. Run: `node test/delivery.test.mjs` (also part of `npm test`).
 *
 * The three host imports (`dsh-typert-protocol`, `cordis`, `dsh-llm`) are
 * redirected to local stubs via a module-resolution hook so the REAL index.js
 * source executes without a DSH host process.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

// Isolate persistence BEFORE index.js computes CONFIG_FILE at import time.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "model-prompt-injector-test-"));
register("./loader.mjs", import.meta.url);

const { ModelPromptInjectorService } = await import("../index.js");

// ---- harness ---------------------------------------------------------------

const captured = {};
const fakeScope = {
  systemPrompt: {
    section: (definition) => {
      captured.section = definition;
    },
  },
  on: (name, handler) => {
    captured.events = captured.events || {};
    captured.events[name] = handler;
    return () => {};
  },
};
const fakeCtx = {
  get: () => undefined,
  inject: (_deps, callback) => {
    captured.injectCallback = callback;
    callback(fakeScope);
    return {};
  },
};

const initSymbol = Object.getOwnPropertySymbols(ModelPromptInjectorService.prototype).find(
  (symbol) => symbol.description === "Service.init"
);

const service = new ModelPromptInjectorService(fakeCtx, {});
await service[initSymbol]();

const textOf = (agent) => captured.section.text({ agent });
const rules = () => service._rules;
const preStep = captured.events["agent/pre-step"];
assert.ok(preStep, "agent/pre-step listener registered");
const admit = (payload) => preStep(payload, async () => ({ kind: "admit", messages: [{ id: "m1" }] }));

const agentOf = (provider, model) => ({ options: { provider, model } });

rules().push(
  { key: "p/*", provider: "p", model: "*", prompt: "BASE" },
  { key: "p/m1", provider: "p", model: "m1", prompt: "R1" }
);

// ---- 1. first delivery goes to the system prompt ---------------------------

const agent = agentOf("p", "m1");
assert.equal(textOf(agent), "BASE\n\nR1", "first delivery in system prompt");

// ---- 2. identical content is never re-injected ------------------------------

assert.equal(textOf(agent), "", "no repeat while unchanged");
assert.equal(textOf(agent), "", "no repeat while unchanged (2nd)");

// ---- 3. per-agent isolation --------------------------------------------------

const other = agentOf("p", "m2");
assert.equal(textOf(other), "BASE", "other agent gets its own first delivery");

// ---- 4. model switch delivers via pre-step notice ----------------------------

agent.options.model = "m2";
assert.equal(textOf(agent), "", "section stays quiet on change");
const switched = await admit({ agent, signal: {} });
assert.equal(switched.messages.length, 2, "notice appended on switch");
const noticeText = switched.messages[1].content[0].text;
assert.ok(noticeText.startsWith("[model prompt rules:"), "switch header");
assert.ok(noticeText.includes("m1 → m2"), "route labels in header");
assert.ok(noticeText.includes("BASE"), "rules in notice body");
assert.equal(switched.messages[1].source.plugin, "model-prompt-injector");
assert.equal(textOf(agent), "", "section quiet after notice delivery");

// ---- 5. no notice when nothing changed ---------------------------------------

const unchanged = await admit({ agent, signal: {} });
assert.equal(unchanged.messages.length, 1, "no notice without change");

// ---- 6. rule edit delivers update notice -------------------------------------

rules()[0].prompt = "BASEb"; // provider-wide rule: affects the current p/m2 route
const edited = await admit({ agent, signal: {} });
assert.equal(edited.messages.length, 2, "edit delivers notice");
const editText = edited.messages[1].content[0].text;
assert.ok(editText.startsWith("[model prompt rules updated for m2]"), "same-route update header");
assert.ok(editText.includes("BASEb"), "edited rules in body");

// ---- 7. switch to unruled route emits clear notice ----------------------------

agent.options.model = "zzz";
agent.options.provider = "q";
const cleared = await admit({ agent, signal: {} });
assert.equal(cleared.messages.length, 2, "clear notice appended");
assert.ok(cleared.messages[1].content[0].text.startsWith("[model prompt rules cleared:"), "clear header");
assert.equal(textOf(agent), "");

// ---- 8. gates -----------------------------------------------------------------

const rejected = await preStep({ agent, signal: {} }, async () => ({ kind: "reject", messages: [] }));
assert.equal(rejected.messages.length, 0, "reject passthrough");
const aborted = await admit({ agent, signal: { aborted: true } });
assert.equal(aborted.messages.length, 1, "aborted adds nothing");
const emptyDecision = await preStep({ agent, signal: {} }, async () => ({ kind: "admit", messages: [] }));
assert.equal(emptyDecision.messages.length, 0, "empty decision adds nothing");

// ---- 9. fallback when pre-step never runs ------------------------------------

agent.options.provider = "p";
agent.options.model = "m1";
assert.equal(textOf(agent), "", "miss 1");
assert.equal(textOf(agent), "", "miss 2");
assert.equal(textOf(agent), "BASEb\n\nR1", "3rd consecutive miss falls back to system prompt");
assert.equal(textOf(agent), "", "quiet again after fallback delivery");

console.log("delivery.test: ALL PASS");
