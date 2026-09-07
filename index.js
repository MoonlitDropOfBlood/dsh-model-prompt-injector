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
 *      returns `{ agent, scope, signal }`), so `context.agent.options`
 *      tells the exact provider/model the upcoming request targets. Rules
 *      matching that route are joined and returned; unmatched routes return
 *      "" and the prompt renderer drops empty sections entirely.
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
    });
  }

  // ---- injection --------------------------------------------------------------

  /**
   * Section text, evaluated before every model step. The runtime assembly
   * context carries the agent (`assembleContextFor` returns
   * `{ agent, scope, signal }`), and `agent.options.provider/model` is the
   * route the upcoming request targets — the same source the loop builds the
   * (deep-frozen) request header from, so matching here is exact. Returns ""
   * for unmatched routes: the prompt renderer drops empty sections, so
   * unmatched models pay nothing. Never throws — a section evaluation failure
   * would otherwise poison the whole assembly.
   */
  _extraPrompt(context) {
    try {
      const agent = context ? context.agent : undefined;
      const options = agent ? agent.options : undefined;
      if (!options) return "";
      const provider = options.provider;
      const model = options.model;
      if (typeof provider !== "string" || provider.length === 0) return "";
      if (typeof model !== "string" || model.length === 0) return "";
      const parts = [];
      for (const rule of this._rules) {
        if (rule.provider !== provider) continue;
        if (rule.model === "*" || rule.model === model) parts.push(rule.prompt);
      }
      return parts.join("\n\n");
    } catch (e) {
      return "";
    }
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
   * flagged via `llm.listProviders()`.
   *
   * Commit-2 stub: filled in with the real enumeration in a later commit.
   */
  _directory() {
    return [];
  }
}

export default ModelPromptInjectorService;
