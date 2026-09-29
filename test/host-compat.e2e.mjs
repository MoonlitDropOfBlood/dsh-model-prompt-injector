/**
 * dsh-model-prompt-injector — REAL-HOST end-to-end compatibility test.
 *
 * `test/delivery.test.mjs` pins the delivery state machine against stubs.
 * This one answers the question that actually matters on a host upgrade:
 * does the plugin still load and work against the REAL DSH runtime?
 *
 * `test/host-loader.mjs` redirects every bare `@deepseek-ai/cordis` /
 * `@deepseek-ai/dsh-*` import to the installed host — DSH ≤ 0.1.x via the
 * profile junction farm, DSH 0.2.0-rc.1+ via the desktop installation checkout
 * (profiles no longer carry host packages) — so this file drives the host's
 * OWN code: its compatibility gate, its Typert manifest validator, a real
 * cordis Context, the host's shipped SECTION_ORDERS, and the host's real
 * client-side typert registry.
 *
 * Covered:
 *   A. the load gate        — evaluatePluginCompatibility() must not deny us
 *   B. the manifest         — validateTypertManifest() on the real typert.host.js
 *   C. the host half boots  — real cordis Context + real TypertRemoteService
 *   D. the service works    — getState/setRule/persistence + delivery state machine
 *   E. section placement    — our order still lands after every shipped section
 *   F. the client half      — $mount descriptors match the host manifest, codecs
 *                             carry create(), settings.section registers
 *
 * Run: `node test/host-compat.e2e.mjs` (also part of `npm test`).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate persistence BEFORE index.js computes CONFIG_FILE at import time.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "model-prompt-injector-host-e2e-"));
register("./host-loader.mjs", import.meta.url);
// The same resolved host copy the loader hooks above import from.
const { hostRequire } = await import("./host-loader.mjs");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const { Context } = await import("@deepseek-ai/cordis");
const { getDshRuntimeVersion, evaluatePluginCompatibility } = await import("@deepseek-ai/dsh-app-boot");
const { validateTypertManifest } = await import("@deepseek-ai/dsh-typert-loader");
const { ModelPromptInjectorService } = await import("../index.js");
const { TYPERT } = await import("../typert.host.js");

const passed = [];
const pass = (name) => passed.push(name);
/**
 * Sequential runner: async check bodies (getState/setRule round-trips) are
 * awaited in registration order, so an assertion fails AT its check instead of
 * drifting into an unhandled rejection, and later checks never race earlier
 * ones. A failure rejects the chain; everything after it is skipped.
 */
let chain = Promise.resolve();
const check = (name, fn) => {
  chain = chain.then(async () => {
    await fn();
    pass(name);
  });
};
/**
 * Poll until the persisted table matches `expectedKeys`. setRule returns
 * before its fire-and-forget `_persist()` lands, so a just-existing file can
 * still hold the previous generation's content.
 */
async function waitForPersistedRules(file, expectedKeys, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      let keys = [];
      try {
        keys = JSON.parse(readFileSync(file, "utf8")).rules.map((r) => r.key);
      } catch (error) {
        /* mid-write read — retry */
      }
      if (JSON.stringify(keys) === JSON.stringify(expectedKeys)) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${file} to hold ${JSON.stringify(expectedKeys)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---- A. the load gate -------------------------------------------------------
// This is the gate behind "profile startup denies it": dsh-app-boot denies any
// profile row whose @deepseek-ai/dsh-* peers miss the running dsh.

const hostVersion = getDshRuntimeVersion();
const issue = evaluatePluginCompatibility(pkg, {}, hostVersion);
assert.equal(
  issue,
  undefined,
  `host dsh ${hostVersion} DENIES this plugin — peerDependencies ${JSON.stringify(issue?.peers)}.\n` +
    "Add the host's own version line to the @deepseek-ai/dsh-* peer ranges.",
);
pass(`A1 compatibility gate accepts peers on dsh ${hostVersion}`);

// ---- B. the Typert manifest -------------------------------------------------

validateTypertManifest(pkg.name, TYPERT);
pass("B1 validateTypertManifest accepts typert.host.js");

for (const invocation of TYPERT.invocations) {
  assert.equal(invocation.result.mode, "strict", `${invocation.id}: result codec must be strict`);
  assert.equal(typeof invocation.result.create, "function", `${invocation.id}: result codec needs create()`);
  for (const parameter of invocation.parameters) {
    assert.equal(parameter.codec.mode, "strict", `${invocation.id}/${parameter.name}: parameter codec must be strict`);
    assert.equal(
      typeof parameter.codec.create,
      "function",
      `${invocation.id}/${parameter.name}: parameter codec needs create()`,
    );
  }
}
pass(`B2 all ${TYPERT.invocations.length} host invocations carry strict codecs with create() factories`);

// ---- E. section placement (parsed up front, asserted after boot) -----------
// Rule text must land at the END of the system prompt, so our section order has
// to stay above every order the host ships. Read the host's real SECTION_ORDERS.

const systemPromptSource = readFileSync(hostRequire.resolve("@deepseek-ai/dsh-system-prompt"), "utf8");
const ordersBlock = systemPromptSource.match(/const SECTION_ORDERS = \{([\s\S]*?)\n\};/);
assert.ok(ordersBlock, "could not read SECTION_ORDERS from the host's dsh-system-prompt");
const shippedOrders = [...ordersBlock[1].matchAll(/: ([-\d.e+]+),?/g)].map((match) =>
  Number(match[1].replace(/_/g, "")),
);
assert.ok(shippedOrders.length > 5, "SECTION_ORDERS parsed empty");
const maxShippedOrder = Math.max(...shippedOrders);

// ---- C. the host half boots on a real cordis Context -----------------------

const registeredSections = [];
const fakeSystemPrompt = {
  section(definition) {
    registeredSections.push(definition);
  },
};
const fakeLlm = {
  listProviders: () => [{ id: "minimax-cn", name: "MiniMax" }],
  listModels: async (provider) =>
    provider === "minimax-cn" ? [{ id: "MiniMax-M3", name: "MiniMax M3" }] : [],
};
const pendingSelections = new Map();
const fakeProjections = {
  stateOf(session, key) {
    assert.equal(key, "modelSelection");
    return { pending: pendingSelections.get(session) };
  },
};

const app = new Context();
// Cordis 4 (0.2.0-rc.1 host): there is no root start()/stop() — ctx.plugin()
// starts the plugin immediately and returns a thenable fiber that settles
// once loading finished (and rethrows startup errors).
await app.plugin((ctx) => {
  ctx.provide("systemPrompt", fakeSystemPrompt);
  ctx.provide("llm", fakeLlm);
  ctx.provide("sessionProjections", fakeProjections);
});
await app.plugin(ModelPromptInjectorService);

check("C1 the class plugin registers the modelPromptInjector service on a real Context", () => {
  assert.ok(app.get("modelPromptInjector"), "service not visible through ctx.get");
});

const service = app.get("modelPromptInjector");
const section = registeredSections[0];

check("C2 the injection section is registered at the system prompt tail", () => {
  assert.equal(registeredSections.length, 1, "exactly one dynamic section");
  assert.equal(section.name, "model-prompt-injector:extra");
  assert.equal(typeof section.text, "function", "section text must be a dynamic function");
  assert.equal(
    section.order,
    maxShippedOrder + 50,
    `SECTION_ORDER ${section.order} must land after every shipped section (host max ${maxShippedOrder})`,
  );
});

check("C3 ctx.inject([\"systemPrompt\"]) resolved and ran its callback", () => {
  // The inject callback registers the section AND binds the root-scope
  // `agent/pre-step` switch-time listener, so a registered section proves the
  // real cordis inject pipeline admitted and ran the callback. The listener's
  // own delivery behaviour is pinned separately by delivery.test.mjs.
  assert.equal(registeredSections.length, 1);
  assert.equal(service.ctx.get("systemPrompt"), fakeSystemPrompt);
});

// ---- D. the service works ---------------------------------------------------

const session = { requestHeader: () => undefined };
const agent = { session, options: { provider: "minimax-cn", model: "MiniMax-M3" } };
const text = () => section.text({ agent });

check("D1 getState returns the settings-page envelope and provider directory", async () => {
  const state = await service.getState();
  assert.equal(state.ok, true);
  assert.deepEqual(state.value.rules, [], "fresh DSH_HOME starts with no rules");
  assert.equal(state.value.providers.length, 1);
  assert.equal(state.value.providers[0].provider, "minimax-cn");
  assert.deepEqual(
    state.value.providers[0].models.map((m) => m.id),
    ["MiniMax-M3"],
    "the model catalog comes from llm.listModels()",
  );
});

check("D2 the first matching route delivers through the system prompt, then stays quiet", async () => {
  assert.equal(text(), "", "no rules yet — nothing to inject");

  const set = await service.setRule({ provider: "minimax-cn", model: "*", prompt: "服务商级规则。" });
  assert.equal(set.ok, true);
  assert.equal(set.value.rules.length, 1);

  assert.equal(text(), "服务商级规则。", "first delivery goes through the system prompt");
  assert.equal(text(), "", "unchanged route must NOT re-inject every step");
  assert.equal(text(), "", "still unchanged");
});

check("D3 an exact model rule stacks on the provider-wide rule, provider first", async () => {
  const set = await service.setRule({ provider: "minimax-cn", model: "MiniMax-M3", prompt: "模型级规则。" });
  assert.equal(set.ok, true);
  assert.deepEqual(
    set.value.rules.map((r) => r.key),
    ["minimax-cn/*", "minimax-cn/MiniMax-M3"],
    "provider/* sorts before the exact model key",
  );
  // A fresh agent has no delivery state, so it gets the full stacked text.
  const fresh = section.text({ agent: { session: {}, options: { provider: "minimax-cn", model: "MiniMax-M3" } } });
  assert.equal(fresh, "服务商级规则。\n\n模型级规则。");
});

check("D4 a blank prompt deletes the rule and it stops injecting", async () => {
  const set = await service.setRule({ provider: "minimax-cn", model: "*", prompt: "   " });
  assert.equal(set.ok, true);
  assert.deepEqual(set.value.rules.map((r) => r.key), ["minimax-cn/MiniMax-M3"]);
  const fresh = section.text({ agent: { session: {}, options: { provider: "minimax-cn", model: "MiniMax-M3" } } });
  assert.equal(fresh, "模型级规则。");
});

check("D5 the rule table is persisted to config.json under DSH_HOME", async () => {
  const configFile = join(process.env.DSH_HOME, "model-prompt-injector", "config.json");
  await waitForPersistedRules(configFile, ["minimax-cn/MiniMax-M3"]);
  const saved = JSON.parse(readFileSync(configFile, "utf8"));
  assert.deepEqual(
    saved.rules.map((r) => r.key),
    ["minimax-cn/MiniMax-M3"],
  );
  assert.equal(saved.rules[0].prompt, "模型级规则。");
});

check("D6 rules survive a reload of a freshly constructed service", async () => {
  const app2 = new Context();
  await app2.plugin((ctx) => {
    ctx.provide("systemPrompt", fakeSystemPrompt);
    ctx.provide("llm", fakeLlm);
    ctx.provide("sessionProjections", fakeProjections);
  });
  await app2.plugin(ModelPromptInjectorService);
  const reloaded = await app2.get("modelPromptInjector").getState();
  assert.deepEqual(reloaded.value.rules.map((r) => r.key), ["minimax-cn/MiniMax-M3"]);
});

check("D7 the pending UI selection outranks agent.options for route resolution", async () => {
  pendingSelections.set(session, { provider: "minimax-cn", model: "MiniMax-M3" });
  const selected = section.text({ agent: { session, options: { provider: "other", model: "other-model" } } });
  assert.equal(selected, "模型级规则。", "the selection layer decides the real route");
  pendingSelections.delete(session);
});

check("D8 an unruled route injects nothing and never throws", async () => {
  assert.equal(section.text({ agent: { session: {}, options: { provider: "nope", model: "nope" } } }), "");
  assert.equal(section.text({ agent: {} }), "", "no session, no options — no crash, no text");
  assert.equal(section.text({}), "", "no assembly context at all — still no crash");
});

// ---- F. the client half -----------------------------------------------------
// Mount client.js against a stub DOM, capture the $mount contribution, and
// check it lines up with the host manifest, then register it in the host's
// REAL client-side typert registry (the exact validation dsh-api-gateway's
// $mount runs) and the settings.section slot contract.

const styleTags = [];
const moduleRegistrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      moduleRegistrations.push(registration);
      globalThis.__clientRegistration = registration;
    },
  },
};
globalThis.document = {
  head: { appendChild: (node) => styleTags.push(node) },
  body: {},
  createElement: () => ({ textContent: "", remove() {} }),
  querySelectorAll: () => [],
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

// The host's OWN client-side typert registry bundle (same wrapper format the
// web shell loads): its apply() installs the real `typert` service, whose
// `remotes.register(contribution)` is exactly what dsh-api-gateway's
// `ctx.remote.$mount` calls under the hood.
await import("@deepseek-ai/dsh-typert-registry/client");
await import("../client.js");
const registration = globalThis.__clientRegistration;
assert.ok(registration, "client.js did not call window.__ModuleLoader__.load");
assert.equal(registration.id, pkg.name, "client module id must be the package name");
const clientExports = registration.factory((specifier) => {
  if (specifier === "react") return { createElement: () => ({}) };
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return { Button: () => {} };
  throw new Error(`unexpected client require: ${specifier}`);
});
assert.deepEqual(clientExports.inject, ["slots", "remote"]);

let mounted = null;
const disposers = [];
const slotRegistrations = [];
const remoteStub = {
  getState: async () => ({ ok: true, value: { rules: [], providers: [] } }),
  setRule: async () => ({ ok: true, value: { rules: [] } }),
};
await clientExports.apply({
  remote: {
    $mount: async (contribution) => {
      mounted = contribution;
      return () => {};
    },
  },
  get: () => remoteStub,
  effect: (fn) => {
    const dispose = fn();
    if (typeof dispose === "function") disposers.push(dispose);
  },
  slots: {
    inject: (_name, register) => register(),
    register: (descriptor, render) => slotRegistrations.push({ descriptor, render }),
  },
});

check("F1 the client mounts its own modelPromptInjector namespace", () => {
  assert.ok(mounted, "client never called ctx.remote.$mount");
  assert.equal(mounted.descriptors.length, TYPERT.invocations.length);
  assert.deepEqual(
    mounted.descriptors.map((d) => d.id).sort(),
    TYPERT.invocations.map((i) => i.id).sort(),
    "client descriptor ids must match the host manifest ids one-for-one",
  );
  for (const descriptor of mounted.descriptors) {
    const host = TYPERT.invocations.find((i) => i.id === descriptor.id);
    assert.equal(descriptor.service, host.service);
    assert.equal(descriptor.namespace, host.namespace);
    assert.equal(descriptor.method, host.method);
    assert.deepEqual(descriptor.invocation, host.invocation);
  }
});

check("F2 every client codec carries a create() factory (0.1.7+ client registry)", () => {
  for (const descriptor of mounted.descriptors) {
    assert.equal(descriptor.result.mode, "strict");
    assert.equal(typeof descriptor.result.create, "function", `${descriptor.id}: result codec needs create()`);
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, "strict");
      assert.equal(
        typeof parameter.codec.create,
        "function",
        `${descriptor.id}/${parameter.name}: parameter codec needs create()`,
      );
    }
  }
});

check("F2+ the REAL 0.2.0 typert-registry accepts the client contribution", () => {
  const registryRegistration = moduleRegistrations.find((r) => r.id === "@deepseek-ai/dsh-typert-registry");
  assert.ok(registryRegistration, "the host's typert-registry client bundle never registered");
  const registryModule = registryRegistration.factory((specifier) => {
    if (specifier === "@deepseek-ai/cordis") return hostRequire("@deepseek-ai/cordis");
    throw new Error(`unexpected typert-registry require: ${specifier}`);
  });
  const registryApp = new Context();
  registryModule.apply(registryApp);
  const typert = registryApp.get("typert");
  assert.ok(typert, "typert service not registered by the real client bundle");
  // Same call dsh-api-gateway's mountContribution() makes: full descriptor
  // validation (ids, endpoints, wire names, strict codecs + create factories).
  const withdraw = typert.remotes.register(mounted);
  assert.equal(typeof withdraw, "function", "register() must return a disposer");
  assert.deepEqual(
    typert.remotes.list().map((d) => d.id).sort(),
    TYPERT.invocations.map((i) => i.id).sort(),
    "the real registry must hold every invocation after mount",
  );
});

check("F3 the settings page registers under settings.section after 模型", () => {
  assert.equal(slotRegistrations.length, 1);
  const { descriptor } = slotRegistrations[0];
  assert.equal(descriptor.name, "settings.section");
  assert.equal(descriptor.id, "model-prompt-injector");
  assert.equal(descriptor.order, 12, "must sort after the built-in 模型 section (order 10)");
  assert.equal(descriptor.label(), "模型提示词");
});

check("F4 the injected stylesheet is installed and disposed with the plugin", () => {
  assert.equal(styleTags.length, 1);
  assert.ok(styleTags[0].textContent.includes(".mpi-page"), "package CSS is present");
  for (const dispose of disposers) dispose();
});

// ---- report ----------------------------------------------------------------

await chain;
console.log(`host e2e — dsh ${hostVersion} (cordis ${JSON.parse(readFileSync(hostRequire.resolve("@deepseek-ai/cordis/package.json"), "utf8")).version})`);
for (const name of passed) console.log(`  ok  ${name}`);
console.log(`  ${passed.length} checks passed`);
