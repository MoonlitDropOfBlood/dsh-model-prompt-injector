/**
 * dsh-model-prompt-injector — Typert Host manifest.
 *
 * Hand-written TYPERT manifest (the format the DSH typert-loader consumes
 * from the package's `./typert` export). It describes the
 * `modelPromptInjector` Remote service the Host half publishes so the
 * browser Client half can call it through `ctx.remote.modelPromptInjector.*`
 * (after mounting the namespace via `ctx.remote.$mount` — see client.js).
 *
 * Keep the invocation ids, service/namespace names and method names in sync
 * with `index.js` (ModelPromptInjectorService) and `client.js`.
 *
 * Result schemas are STRICT: every Host return value must match exactly
 * (fields present, types correct), or the gateway validation fails.
 *
 * Codec contract spans two host generations (same as client.js): 0.1.5 loads
 * and parses through `codec.schema` (a zod v4 instance — the typert-loader
 * checks `"_zod" in schema`, the gateway calls `codec.schema.parse`), while
 * 0.1.7-rc.1+ requires a `codec.create()` FACTORY (the typert-loader's
 * requireStrictCodec REJECTS any strict codec with no create() factory at
 * startup, which aborts the typert registry build and takes OTHER services'
 * remote methods down with it — e.g. llm/listProviders). Every codec below
 * therefore carries BOTH fields: `schema` keeps 0.1.5 loading, `create`
 * keeps 0.1.7 loading, and both generations parse through the same zod
 * instance (same pattern as dsh-agent-approval 1.7.x / dsh-token-stats 1.5.x).
 */

import { z } from "zod";

// ---- shared shapes ----------------------------------------------------------

const ruleSchema = z
  .object({
    key: z.string(),
    provider: z.string(),
    model: z.string(),
    prompt: z.string(),
    updatedAt: z.string(),
  })
  .readonly();

const targetModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .readonly();

const targetProviderSchema = z
  .object({
    provider: z.string(),
    displayName: z.string(),
    active: z.boolean(),
    models: z.array(targetModelSchema).readonly(),
  })
  .readonly();

const stateValueSchema = z
  .object({
    rules: z.array(ruleSchema).readonly(),
    providers: z.array(targetProviderSchema).readonly(),
  })
  .readonly();

const rulesValueSchema = z
  .object({
    rules: z.array(ruleSchema).readonly(),
  })
  .readonly();

/** The shared ok|error envelope. */
function okResult(valueSchema) {
  return z.union([
    z
      .object({
        ok: z.literal(true).readonly(),
        value: valueSchema.readonly(),
      })
      .readonly(),
    z
      .object({
        ok: z.literal(false).readonly(),
        error: z
          .object({
            code: z.string().readonly(),
            message: z.string().readonly().optional(),
          })
          .readonly(),
      })
      .readonly(),
  ]);
}

const stateResultSchema = okResult(stateValueSchema);
const setRuleResultSchema = okResult(rulesValueSchema);

// ---- per-invocation parameter schemas ---------------------------------------

const _modelPromptInjector_setRule_parameter_0$schema = z.object({
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
});

export const TYPERT = {
  package: "@duke-dsh-plugins/dsh-model-prompt-injector",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-model-prompt-injector#modelPromptInjector/getState",
      service: "modelPromptInjector",
      namespace: "modelPromptInjector",
      method: "getState",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-model-prompt-injector#ModelPromptInjectorStateResult",
        schema: stateResultSchema,
        create: () => stateResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-model-prompt-injector#modelPromptInjector/setRule",
      service: "modelPromptInjector",
      namespace: "modelPromptInjector",
      method: "setRule",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-model-prompt-injector#ModelPromptInjectorSetRuleRequest",
            schema: _modelPromptInjector_setRule_parameter_0$schema,
            create: () => _modelPromptInjector_setRule_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-model-prompt-injector#ModelPromptInjectorSetRuleResult",
        schema: setRuleResultSchema,
        create: () => setRuleResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        description:
          "Per-model system-prompt injection service: appends persisted per-route rules (exact provider/model or provider-wide provider/*) to the end of the system prompt on every matching model step, and serves the Settings page state (rule table + locally configured provider/model directory) to the DeepSeek Harness web UI.",
        summary: "Per-model system-prompt injection service.",
        tags: [],
        jsDoc:
          "/**\n * Per-model system-prompt injection: persisted rules appended to the system prompt tail per matching route.\n */",
        key: "modelPromptInjector",
        exportName: "ModelPromptInjectorService",
        members: [
          {
            kind: "method",
            name: "getState",
            signature: "@Remote('getState') async getState(): Promise<ModelPromptInjectorStateResult>",
            summary: "Snapshot for the Settings page (rule table + configured provider/model directory).",
            jsDoc:
              "/**\n * Return the persisted rule table plus the directory of locally configured providers and their models.\n * @returns success or a business failure.\n */",
          },
          {
            kind: "method",
            name: "setRule",
            signature:
              "@Remote('setRule') async setRule(request: ModelPromptInjectorSetRuleRequest): Promise<ModelPromptInjectorSetRuleResult>",
            summary: "Upsert one rule (blank prompt deletes it) and persist the table.",
            jsDoc:
              "/**\n * Upsert the rule for one exact provider/model or a provider-wide model of \"*\"; a blank prompt deletes the rule.\n * @param request - { provider, model, prompt }.\n * @returns the full rule table.\n */",
          },
        ],
        types: [
          {
            name: "ModelPromptInjectorRule",
            declaration:
              "export interface ModelPromptInjectorRule {\n    readonly key: string;\n    readonly provider: string;\n    readonly model: string;\n    readonly prompt: string;\n    readonly updatedAt: string;\n}",
          },
          {
            name: "ModelPromptInjectorTargetModel",
            declaration:
              "export interface ModelPromptInjectorTargetModel {\n    readonly id: string;\n    readonly name: string;\n}",
          },
          {
            name: "ModelPromptInjectorTargetProvider",
            declaration:
              "export interface ModelPromptInjectorTargetProvider {\n    readonly provider: string;\n    readonly displayName: string;\n    readonly active: boolean;\n    readonly models: readonly ModelPromptInjectorTargetModel[];\n}",
          },
          {
            name: "ModelPromptInjectorSetRuleRequest",
            declaration:
              "export interface ModelPromptInjectorSetRuleRequest {\n    readonly provider: string;\n    readonly model: string;\n    readonly prompt: string;\n}",
          },
          {
            name: "ModelPromptInjectorStateValue",
            declaration:
              "export interface ModelPromptInjectorStateValue {\n    readonly rules: readonly ModelPromptInjectorRule[];\n    readonly providers: readonly ModelPromptInjectorTargetProvider[];\n}",
          },
          {
            name: "ModelPromptInjectorStateResult",
            declaration:
              "export type ModelPromptInjectorStateResult = { ok: true; value: ModelPromptInjectorStateValue } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "ModelPromptInjectorRulesValue",
            declaration:
              "export interface ModelPromptInjectorRulesValue {\n    readonly rules: readonly ModelPromptInjectorRule[];\n}",
          },
          {
            name: "ModelPromptInjectorSetRuleResult",
            declaration:
              "export type ModelPromptInjectorSetRuleResult = { ok: true; value: ModelPromptInjectorRulesValue } | { ok: false; error: { code: string; message?: string } };",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
};
