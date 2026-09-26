/**
 * dsh-model-prompt-injector — Host half.
 *
 * A Cordis "class plugin": this module exports `ModelPromptInjectorService`
 * extending `TypertRemoteService`. The DSH loader instantiates the class and
 * registers it as the `modelPromptInjector` service; the Typert Gateway
 * exposes its Remote-marked methods to the browser Client half under the
 * `modelPromptInjector` Remote namespace.
 *
 * What it does:
 *
 *   1. INJECT — registers ONE dynamic system-prompt section
 *      (`model-prompt-injector:extra`, order 9950 — after every shipped
 *      section, so rule text lands at the END of the system prompt). The
 *      section text is a function evaluated before EVERY model step; the
 *      runtime assembly context carries the agent (`assembleContextFor`
 *      returns `{ agent, scope, signal }`). The route the upcoming request
 *      targets is resolved from the model-selection chain (pending UI
 *      selection → last logged request header → creation-time options),
 *      because since DSH 0.1.5 `agent.options` alone diverges from the real
 *      route whenever the user picks a model in the UI. Rules matching that
 *      route are joined and returned; unmatched routes return "" and the
 *      prompt renderer drops empty sections entirely.
 *
 *   2. PERSIST — rules live in `<DSH_HOME>/model-prompt-injector/config.json`
 *      (outside any profile's node_modules, so reinstalls and upgrades never
 *      touch it) and are hydrated at init: rule edits survive DSH restarts.
 *
 *   3. SERVE  — two Remote methods for the Settings page: `getState`
 *      (rule table + the directory of LOCALLY CONFIGURED providers/models,
 *      enumerated exactly like the Models settings page: the configurable
 *      provider directory + each namespace's `[...settingsPath, "models"]`)
 *      and `setRule` (upsert; a blank prompt deletes).
 *
 * Rule matching:
 *   - key shape `provider/model` targets one exact model (ids are
 *     case-sensitive route ids, e.g. `minimax-cn/MiniMax-M3`);
 *   - key shape `provider/*` is a provider-wide rule applying to every model
 *     of that provider. Both kinds stack, provider-wide first (the `*` key
 *     sorts before any model id in the table's ascending key order).
 *
 * Mount on the HOST plane (the package's cordis.patch.yml insert row): the
 * section registration must live in the root scope so EVERY agent's assembly
 * (main sessions, subagents, workflow children) sees it.
 */

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- constants --------------------------------------------------------------

/** The registered prompt section name (unique; nobody else shadows it). */
const SECTION_NAME = "model-prompt-injector:extra";
/**
 * Section placement: the shipped SECTION_ORDERS max out at
 * STRUCTURED_OUTPUT = 9900 (see @deepseek-ai/dsh-system-prompt), so 9950
 * appends rule text at the very end of the system prompt.
 */
const SECTION_ORDER = 9950;

/**
 * On-disk persistence for the rule table. Lives under DSH_HOME, outside any
 * profile's node_modules so reinstalls and upgrades never touch it.
 */
const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "model-prompt-injector");
const CONFIG_FILE = join(DATA_DIR, "config.json");

/** Rule key = `provider/model`; `*` as model marks the provider-wide rule. */
function ruleKey(provider, model) {
  return provider + "/" + model;
}

/** Route equality; undefined never equals anything (defensive). */
function sameRoute(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.provider === right.provider &&
    left.model === right.model
  );
}

/**
 * Short route label, mirroring the host's model-selection notice: the
 * provider is omitted when both routes share it.
 */
function routeLabel(route, other) {
  if (route === undefined) return "(unknown)";
  return other !== undefined && route.provider === other.provider
    ? route.model
    : route.provider + "/" + route.model;
}

/** Bound one notice summary line (host limit is 120 chars). */
function clipSummary(text) {
  return text.length <= 120 ? text : text.slice(0, 119) + "…";
}

/**
 * Build the switch-time notice message. It rides the same `agent/pre-step`
 * injection point as the host's `[model changed]` notice, so a model switch
 * announces both the route change and the rules that now apply, in adjacent
 * user messages. A switch to an unruled route emits an explicit clear notice
 * so stale rules never linger silently.
 */
function buildRulesNotice(previousRoute, route, text) {
  const to = routeLabel(route, previousRoute);
  if (text.length === 0) {
    return createUserMessage({
      content: [
        {
          type: "text",
          text: `[model prompt rules cleared: no prompt rules apply to ${to}]`,
        },
      ],
      source: {
        kind: "plugin",
        plugin: "model-prompt-injector",
        form: "notice",
        summary: clipSummary(`模型提示词规则已清除（${to}）`),
      },
    });
  }
  const header = sameRoute(previousRoute, route)
    ? `[model prompt rules updated for ${to}]`
    : `[model prompt rules: ${routeLabel(previousRoute, route)} → ${to}; ` +
      `the rules below apply to the current model]`;
  return createUserMessage({
    content: [{ type: "text", text: header + "\n\n" + text }],
    source: {
      kind: "plugin",
      plugin: "model-prompt-injector",
      form: "notice",
      summary: clipSummary(
        sameRoute(previousRoute, route)
          ? `模型提示词规则已更新（${to}）`
          : `模型提示词规则 ${routeLabel(previousRoute, route)} → ${to}`
      ),
    },
  });
}

// ---- helpers ----------------------------------------------------------------

/**
 * Mark one instance method as a Remote export without relying on decorator
 * syntax (Node ESM does not support the proposal decorators here). We drive
 * the same `Remote(name)` decorator manually through a synthetic decorator
 * context and run the registered initializers against the instance.
 */
function markRemoteMethod(instance, method, exportName) {
  const decorator = Remote(method, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

/** Coerce one persisted/remote record into a clean rule, or null when invalid. */
function sanitizeRule(input) {
  if (!input || typeof input !== "object") return null;
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (provider.length === 0 || model.length === 0 || prompt.trim().length === 0) return null;
  const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString();
  return { key: ruleKey(provider, model), provider, model, prompt, updatedAt };
}

/** Defensive path navigation over a plain settings value (never throws). */
function getPath(value, path) {
  let node = value;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/** Best-effort error text. */
function errText(e) {
  return e && typeof e.message === "string" ? e.message : String(e);
}

// ---- service ----------------------------------------------------------------

export class ModelPromptInjectorService extends TypertRemoteService {
  /**
   * No hard dependencies: every capability surface (`systemPrompt` for the
   * injection, `llm`/`settings` for the directory) is mounted optionally so
   * the plugin keeps serving its settings page (and stored rules) even when
   * one registry is absent from the composition.
   */

  /**
   * Cordis instantiates class plugins with `new Callback(ctx, config)` — the
   * second argument is the plugin config, NOT the service key. Pass the exact
   * service key to `super()`.
   */
  constructor(ctx, config) {
    super(ctx, "modelPromptInjector");
  }

  /**
   * Cordis class-plugin initializer: mark the Remote methods, hydrate the
   * persisted rule table, then mount the injection section.
   */
  async [Service.init]() {
    markRemoteMethod(this, "getState", "getState");
    markRemoteMethod(this, "setRule", "setRule");

    /**
     * The rule table: [{ key, provider, model, prompt, updatedAt }], kept
     * ascending by key so a provider-wide `provider/*` entry (0x2A) always
     * sorts before that provider's exact-model entries and therefore injects
     * first. Persisted in config.json.
     */
    this._rules = [];

    /**
     * Per-agent delivery bookkeeping (WeakMap keyed by the runtime agent
     * object, so discarded agents collect automatically): what route's rules
     * have been injected into context and how. The FIRST injection for an
     * agent goes into the system prompt (the section below); every later
     * change (model switch or rule edit) is delivered as a one-time user
     * notice at the `agent/pre-step` injection point — the same moment the
     * host's model-selection layer appends its `[model changed]` notice —
     * instead of re-injecting the system prompt on every step.
     *   { route: { provider, model }, text: string, misses?: number }
     */
    this._delivered = new WeakMap();

    await this._loadPersisted();

    // The injection itself: one dynamic section in the ROOT scope, so every
    // agent's per-step assembly (main sessions, subagents, workflow children)
    // evaluates it. `ctx.inject` mounts the contribution only while the
    // systemPrompt registry is composed and unwinds cleanly with it.
    this.ctx.inject(["systemPrompt"], (scope) => {
      scope.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: (context) => this._extraPrompt(context),
      });

      /**
       * Switch-time delivery. A root-scope listener admits every descendant
       * agent scope's dispatch (scopeTarget admits untagged listeners
       * globally; events flow up, never down). The listener runs outermost,
       * so the decision already carries the host's `[model changed]` notice
       * and ours lands right after it. Never throws — a listener failure
       * must not poison step admission.
       */
      const disposePreStep = scope.on("agent/pre-step", async ({ agent, signal }, next) => {
        const decision = await next();
        try {
          if (decision.kind === "reject") return decision;
          if (signal && signal.aborted) return decision;
          if (agent === undefined || agent === null) return decision;
          if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision;
          const state = this._delivered.get(agent);
          // No delivery yet: the first one is reserved for the system prompt.
          if (state === undefined) return decision;
          const route = this._resolveRoute(agent);
          if (route === undefined) return decision;
          const text = this._rulesText(route);
          if (sameRoute(state.route, route) && state.text === text) return decision;
          const notice = buildRulesNotice(state.route, route, text);
          state.route = route;
          state.text = text;
          state.misses = 0;
          return { ...decision, messages: [...decision.messages, notice] };
        } catch (e) {
          /* never poison step admission */
          return decision;
        }
      });
      return () => disposePreStep();
    });
  }

  // ---- injection --------------------------------------------------------------

  /**
   * Section text, evaluated before every model step. Delivery model:
   *
   *   - FIRST delivery for an agent (its first assembled route that matches
   *     any rule) returns the rules here, in the system prompt.
   *   - While nothing changed (same route, same matched text) returns "" —
   *     the renderer drops empty sections, so the system prompt is not
   *     re-injected on every step.
   *   - On a change (model switch or rule edit) returns "" here; the update
   *     is delivered as a one-time user notice at the `agent/pre-step`
   *     injection point (see [Service.init]) — the same moment the host
   *     announces the model switch.
   *
   * If the pipeline never runs `agent/pre-step` for an agent (unexpected),
   * the same mismatch is observed here three assemblies in a row and the
   * update falls back to system-prompt delivery rather than being dropped.
   * Never throws — a section evaluation failure would poison the assembly.
   */
  _extraPrompt(context) {
    try {
      const agent = context ? context.agent : undefined;
      const route = this._resolveRoute(agent);
      const text = this._rulesText(route);
      if (route === undefined) {
        // Route temporarily unknowable: make no delivery decision and leave
        // any existing state untouched (avoids false mismatches).
        return "";
      }
      if (agent === undefined || agent === null) {
        // No agent identity — no per-agent bookkeeping possible; degrade to
        // a plain always-fresh section.
        return text;
      }
      const state = this._delivered.get(agent);
      if (state === undefined) {
        if (text.length > 0) this._delivered.set(agent, { route, text, misses: 0 });
        return text;
      }
      if (sameRoute(state.route, route) && state.text === text) {
        state.misses = 0;
        return "";
      }
      state.misses = (state.misses || 0) + 1;
      if (state.misses >= 3) {
        state.route = route;
        state.text = text;
        state.misses = 0;
        return text;
      }
      return "";
    } catch (e) {
      return "";
    }
  }

  /**
   * The matched rule text for one resolved route: every provider-wide
   * `provider/*` rule plus the exact `provider/model` rule, table order,
   * joined by blank lines. Empty string for unmatched routes.
   */
  _rulesText(route) {
    if (route === undefined) return "";
    const parts = [];
    for (const rule of this._rules) {
      if (rule.provider !== route.provider) continue;
      if (rule.model === "*" || rule.model === route.model) parts.push(rule.prompt);
    }
    return parts.join("\n\n");
  }

  /**
   * Resolve the provider/model route the upcoming request will target, in the
   * same precedence the host's model-selection layer applies to requests
   * (api-session-controller `selectionFor().current`):
   *
   *   1. a pending UI selection — the durable `modelSelection` session
   *      projection's `pending` (set by the UI, cleared once a matching
   *      request header is logged);
   *   2. the last logged request header's config — the actual route the
   *      session is already on (for agents without the selection layer this
   *      equals their options anyway);
   *   3. the agent's creation-time options — the real route for agents that
   *      never install the selection layer (subagents, SDK, workflow
   *      children), and equal to the configured default for fresh web
   *      sessions (the controller seeds options from
   *      `agentDefaultModel.currentSelection()`).
   *
   * The configured default is deliberately NOT consulted directly: for
   * layer-less agents it would inject the default provider's rules into a
   * session actually routed elsewhere. Every step is defensive; the function
   * never throws and returns undefined only when no route is knowable.
   */
  _resolveRoute(agent) {
    // 1. Pending UI selection (durable mirror of the controller's picked).
    const projections = this.ctx.get("sessionProjections");
    if (projections !== undefined && agent && agent.session) {
      try {
        const state = projections.stateOf(agent.session, "modelSelection");
        const pending = state ? state.pending : undefined;
        if (pending && typeof pending.provider === "string" && pending.provider.length > 0 && typeof pending.model === "string" && pending.model.length > 0) {
          return { provider: pending.provider, model: pending.model };
        }
      } catch (e) {
        /* projection missing or unreadable — fall through */
      }
    }
    // 2. Last logged request route.
    if (agent && agent.session && typeof agent.session.requestHeader === "function") {
      try {
        const header = agent.session.requestHeader();
        const config = header ? header.config : undefined;
        if (config && typeof config.provider === "string" && config.provider.length > 0 && typeof config.model === "string" && config.model.length > 0) {
          return { provider: config.provider, model: config.model };
        }
      } catch (e) {
        /* unreadable header — fall through */
      }
    }
    // 3. Creation-time options (the real route for layer-less agents).
    const options = agent ? agent.options : undefined;
    if (options && typeof options.provider === "string" && options.provider.length > 0 && typeof options.model === "string" && options.model.length > 0) {
      return { provider: options.provider, model: options.model };
    }
    return undefined;
  }

  // ---- persistence ----------------------------------------------------------

  /** Hydrate the rule table from config.json (never throws). */
  async _loadPersisted() {
    try {
      const raw = await readFile(CONFIG_FILE, "utf8");
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.rules)) {
        const clean = [];
        for (const entry of data.rules) {
          const rule = sanitizeRule(entry);
          if (rule !== null) clean.push(rule);
        }
        clean.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        this._rules = clean;
      }
    } catch (e) {
      /* first run or a corrupt file both start empty */
    }
  }

  /**
   * Persist the rule table (fire-and-forget, best-effort): a persistence
   * failure must never break the settings UI or the injection path — the
   * in-memory table stays authoritative for this process either way.
   */
  _persist() {
    const payload = JSON.stringify({ version: 1, rules: this._rules }, null, 2);
    mkdir(DATA_DIR, { recursive: true })
      .then(() => writeFile(CONFIG_FILE, payload, "utf8"))
      .catch(() => {});
  }

  /** Detached, display-ordered copy of the rule table. */
  _rulesSnapshot() {
    return this._rules.map((rule) => ({
      key: rule.key,
      provider: rule.provider,
      model: rule.model,
      prompt: rule.prompt,
      updatedAt: rule.updatedAt,
    }));
  }

  // ---- Remote methods ---------------------------------------------------------

  /**
   * Settings page snapshot: the rule table plus the directory of locally
   * configured providers/models (see _directory).
   */
  async getState() {
    return { ok: true, value: { rules: this._rulesSnapshot(), providers: this._directory() } };
  }

  /**
   * Upsert one rule; a blank prompt deletes it. Returns the full table so the
   * client can replace its state wholesale.
   */
  async setRule(request) {
    try {
      const provider = typeof request.provider === "string" ? request.provider.trim() : "";
      const model = typeof request.model === "string" ? request.model.trim() : "";
      const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
      if (provider.length === 0 || model.length === 0) {
        return { ok: false, error: { code: "invalid-argument", message: "provider and model are required" } };
      }
      const key = ruleKey(provider, model);
      const index = this._rules.findIndex((rule) => rule.key === key);
      if (prompt.length === 0) {
        if (index !== -1) this._rules.splice(index, 1);
      } else {
        const next = { key, provider, model, prompt, updatedAt: new Date().toISOString() };
        if (index === -1) this._rules.push(next);
        else this._rules[index] = next;
        this._rules.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      }
      this._persist();
      return { ok: true, value: { rules: this._rulesSnapshot() } };
    } catch (e) {
      return { ok: false, error: { code: "internal", message: errText(e) } };
    }
  }

  // ---- provider/model directory ---------------------------------------------

  /**
   * The directory of LOCALLY CONFIGURED providers and their model catalogs,
   * enumerated exactly like the Models settings page: walk the configurable
   * provider directory, keep entries whose settings namespace is registered
   * and whose settingsPath resolves, then read each entry's model list at
   * `[...settingsPath, "models"]`. Active routes (a mounted adapter) are
   * flagged via `llm.listProviders()`. Only detached leaf values cross the
   * wire; a missing `llm`/`settings` registry degrades to an empty list.
   *
   * Provider values come from one `settings.describe()` snapshot (one
   * descriptor per namespace carrying the effective `value`, the same field the
   * Models settings page reads). `settings.get(ns)` is gone as of DSH 0.1.7;
   * calling it threw into the per-entry catch and emptied the directory.
   */
  _directory() {
    const out = [];
    const llm = this.ctx.get("llm");
    if (llm === undefined) return out;
    const settings = this.ctx.get("settings");
    /** Settings namespaces by profile entry id, from one describe() snapshot. */
    const namespaces = new Map();
    if (settings !== undefined) {
      try {
        for (const descriptor of settings.describe()) {
          if (descriptor && typeof descriptor.ns === "string") namespaces.set(descriptor.ns, descriptor);
        }
      } catch (e) {
        /* an unreadable settings registry degrades to an empty directory */
      }
    }
    const active = new Set();
    try {
      for (const info of llm.listProviders()) {
        if (info && typeof info.id === "string") active.add(info.id);
      }
    } catch (e) {
      /* an empty active set only affects the badge */
    }
    let entries = [];
    try {
      entries = llm.listConfigurableProviders();
    } catch (e) {
      return out;
    }
    for (const entry of entries) {
      try {
        const settingsPath = Array.isArray(entry.settingsPath) ? entry.settingsPath : [];
        const namespace = typeof entry.settingsNs === "string" ? namespaces.get(entry.settingsNs) : undefined;
        const value = namespace === undefined ? undefined : namespace.value;
        const configured =
          value !== undefined && (settingsPath.length === 0 || getPath(value, settingsPath) !== undefined);
        if (!configured) continue;
        const rawModels = getPath(value, settingsPath.concat(["models"]));
        const models = [];
        if (Array.isArray(rawModels)) {
          for (const item of rawModels) {
            if (item && typeof item === "object" && typeof item.id === "string" && item.id.length > 0) {
              models.push({
                id: item.id,
                name: typeof item.name === "string" && item.name.length > 0 ? item.name : item.id,
              });
            }
          }
        }
        out.push({
          provider: String(entry.provider),
          displayName:
            typeof entry.displayName === "string" && entry.displayName.length > 0
              ? entry.displayName
              : String(entry.provider),
          active: active.has(entry.provider),
          models,
        });
      } catch (e) {
        /* one unreadable entry does not sink the directory */
      }
    }
    return out;
  }
}

export default ModelPromptInjectorService;
