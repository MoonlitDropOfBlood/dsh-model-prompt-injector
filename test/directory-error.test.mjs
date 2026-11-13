/**
 * Behavioral test of the provider/model directory error reporting (index.js
 * + typert.host.js) against stubbed host packages.
 * Run: `node test/directory-error.test.mjs`.
 *
 * The three host imports (`dsh-typert-protocol`, `cordis`, `dsh-llm`) are
 * redirected to local stubs via a module-resolution hook so the REAL index.js
 * source executes without a DSH host process.
 *
 * What is asserted here — the silent-failure contract:
 *   1. `llm` not mounted      → an EXPLICIT reason, not an empty list;
 *   2. `listProviders()` throws → the exception message is in the reason;
 *   3. one provider's `listModels()` fails → the OTHER providers are still
 *      listed, and the failing provider is named in the reason;
 *   4. the healthy path       → `directoryError` is ABSENT (wire shape
 *      unchanged), and a genuinely empty provider list carries no reason
 *      ("no provider configured" must stay distinguishable from "broken");
 *   5. the host's strict zod schema accepts the new OPTIONAL field.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

// Isolate persistence BEFORE index.js computes CONFIG_FILE at import time.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "model-prompt-injector-directory-test-"));
register("./loader.mjs", import.meta.url);

const { ModelPromptInjectorService } = await import("../index.js");
const { TYPERT } = await import("../typert.host.js");

// ---- harness ---------------------------------------------------------------

const initSymbol = Object.getOwnPropertySymbols(ModelPromptInjectorService.prototype).find(
  (symbol) => symbol.description === "Service.init",
);
assert.ok(initSymbol, "Service.init symbol not found on the service prototype");

/** Build a service whose `ctx.get("llm")` resolves to the given value. */
async function serviceWithLlm(llm) {
  const warnings = [];
  const fakeCtx = {
    get: (key) => (key === "llm" ? llm : undefined),
    logger: (name) => ({
      warn: (message) => warnings.push(message),
      error: (message) => warnings.push(message),
      info: () => {},
      debug: () => {},
    }),
    inject: (_deps, callback) => {
      callback({
        systemPrompt: { section: () => {} },
        on: () => () => {},
      });
      return {};
    },
  };
  const service = new ModelPromptInjectorService(fakeCtx, {});
  await service[initSymbol]();
  return { service, warnings };
}

const stateOf = async (service) => (await service.getState()).value;

// ---- 1. llm service not mounted ---------------------------------------------

{
  const { service, warnings } = await serviceWithLlm(undefined);
  const state = await stateOf(service);
  assert.ok(state.directoryError, "a missing llm service must carry an explicit reason");
  assert.match(state.directoryError, /llm 服务不可用/, "reason names the llm service as unavailable");
  assert.deepEqual(state.providers, [], "no providers can be listed without llm");
  assert.ok(
    warnings.length > 0 && warnings[0].includes("llm 服务不可用"),
    "the degradation is logged on the host side too",
  );
  console.log("  ok 1 llm service missing -> explicit directoryError (not a silent empty list)");
}

// ---- 2. llm.listProviders() throws -------------------------------------------

{
  const boom = new Error("route registry unavailable");
  const { service } = await serviceWithLlm({
    listProviders: () => {
      throw boom;
    },
  });
  const state = await stateOf(service);
  assert.ok(state.directoryError, "a throwing listProviders() must carry an explicit reason");
  assert.match(
    state.directoryError,
    /读取服务商列表失败/,
    "reason says the provider list could not be read",
  );
  assert.match(
    state.directoryError,
    /route registry unavailable/,
    "reason carries the exception message",
  );
  assert.deepEqual(state.providers, [], "no provider can be listed");
  console.log("  ok 2 listProviders() throws -> directoryError carries the exception message");
}

// ---- 3. one provider's listModels() fails -------------------------------------

{
  const { service } = await serviceWithLlm({
    listProviders: () => [
      { id: "minimax-cn", name: "MiniMax" },
      { id: "broken", name: "Broken" },
      { id: "zai-coding-cn", name: "ZAI" },
    ],
    listModels: async (provider) => {
      if (provider === "broken") throw new Error("catalog timeout");
      if (provider === "minimax-cn") return [{ id: "MiniMax-M3", name: "MiniMax M3" }];
      return [{ id: "glm-4", name: "GLM 4" }];
    },
  });
  const state = await stateOf(service);
  assert.equal(state.providers.length, 3, "the other providers are still listed");
  assert.deepEqual(
    state.providers.map((p) => p.provider),
    ["minimax-cn", "broken", "zai-coding-cn"],
    "every provider is present",
  );
  assert.deepEqual(
    state.providers[0].models.map((m) => m.id),
    ["MiniMax-M3"],
    "a healthy provider keeps its models",
  );
  assert.deepEqual(state.providers[1].models, [], "the failing provider degrades to no models");
  assert.deepEqual(
    state.providers[2].models.map((m) => m.id),
    ["glm-4"],
    "a provider AFTER the failing one is unaffected",
  );
  assert.ok(state.directoryError, "the partial failure is reported");
  assert.match(state.directoryError, /broken/, "the reason names the failing provider");
  assert.match(state.directoryError, /catalog timeout/, "the reason carries the exception message");
  assert.ok(
    !state.directoryError.includes("minimax-cn"),
    "the healthy providers are not blamed",
  );
  console.log("  ok 3 one provider's listModels() fails -> others survive, reason names the culprit");
}

// ---- 4. the healthy path ------------------------------------------------------

{
  const { service, warnings } = await serviceWithLlm({
    listProviders: () => [{ id: "minimax-cn", name: "MiniMax" }],
    listModels: async () => [{ id: "MiniMax-M3", name: "MiniMax M3" }],
  });
  const state = await stateOf(service);
  assert.equal(
    state.directoryError,
    undefined,
    "the healthy path carries no directoryError (backward compatible wire shape)",
  );
  assert.ok(!("directoryError" in state), "the key is absent, not merely undefined-valued");
  assert.equal(state.providers.length, 1, "the provider is listed");
  assert.deepEqual(warnings, [], "a healthy directory logs nothing");
  console.log("  ok 4 healthy path -> no directoryError key at all");
}

// ---- 5. a genuinely empty provider list is NOT an error ------------------------

{
  const { service } = await serviceWithLlm({
    listProviders: () => [],
    listModels: async () => [],
  });
  const state = await stateOf(service);
  assert.deepEqual(state.providers, [], "no providers configured");
  assert.equal(
    state.directoryError,
    undefined,
    "'no provider configured' stays distinguishable from 'the directory could not be read'",
  );
  console.log("  ok 5 empty provider list -> no directoryError (not a failure)");
}

// ---- 6. the host's strict schema accepts the new optional field ----------------

{
  const invocation = TYPERT.invocations.find(
    (entry) => entry.method === "getState" && entry.namespace === "modelPromptInjector",
  );
  assert.ok(invocation, "the getState invocation is declared in typert.host.js");
  assert.equal(invocation.result.mode, "strict", "the result codec stays strict");
  assert.equal(typeof invocation.result.create, "function", "the result codec keeps its create() factory");

  const schema = invocation.result.create();
  const withError = {
    ok: true,
    value: { rules: [], providers: [], directoryError: "llm 服务不可用：宿主未挂载 llm 服务" },
  };
  const parsed = schema.parse(withError);
  assert.equal(
    parsed.value.directoryError,
    "llm 服务不可用：宿主未挂载 llm 服务",
    "the strict schema keeps the declared optional field",
  );

  const withoutError = { ok: true, value: { rules: [], providers: [] } };
  const parsedHealthy = schema.parse(withoutError);
  assert.equal(
    parsedHealthy.value.directoryError,
    undefined,
    "the field stays optional — a healthy snapshot parses unchanged",
  );

  // The schema must REJECT a wrong-typed value (it is strict about the shape).
  assert.throws(
    () => schema.parse({ ok: true, value: { rules: [], providers: [], directoryError: 42 } }),
    "a non-string directoryError is rejected by the strict schema",
  );
  console.log("  ok 6 the host's strict schema accepts the optional directoryError field");
}

console.log("directory-error.test: ALL PASS");
