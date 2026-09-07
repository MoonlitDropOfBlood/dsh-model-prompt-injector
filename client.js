/**
 * dsh-model-prompt-injector — Client half (web bundle).
 *
 * Rendered by the DSH web shell via `window.__ModuleLoader__.load`. Adds a
 * "模型提示词" page to the Settings panel (`settings.section`, right after
 * 模型): every locally configured provider card lists its models, each row
 * edits that route's appended system-prompt rule, and a provider-wide
 * `provider/*` row covers the whole provider.
 *
 * Host communication goes through the `modelPromptInjector` Remote namespace
 * (`ctx.remote.modelPromptInjector.*`), published by the Host half in
 * `index.js` and mounted below via `ctx.remote.$mount`.
 *
 * Style notes: no `?.` / `??` (conservative bundle syntax, same as
 * dsh-agent-approval / dsh-token-stats); buttons are the official Button atom
 * (`@deepseek-ai/dsh-client-ui-primitives`, backed by the
 * `--dsw-alias-button-*` token family) so light/dark themes are automatic.
 */
window.__ModuleLoader__.load({
  id: "@duke-dsh-plugins/dsh-model-prompt-injector",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const ui = require("@deepseek-ai/dsh-client-ui-primitives");

    // ---- CSS (package-owned, DSH design tokens) ------------------------------
    const CSS = `
.mpi-page{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;max-width:860px}
.mpi-intro{margin:0;color:var(--dsw-alias-label-secondary);line-height:1.7}
.mpi-provider{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px}
.mpi-provider-head{display:flex;align-items:baseline;gap:8px;padding-bottom:4px}
.mpi-provider-name{font-weight:600;font-size:14px}
.mpi-id{color:var(--dsw-alias-label-secondary);font-family:monospace;font-size:12px}
.mpi-state{margin-left:auto;font-size:11px}
.mpi-state-on{color:var(--dsw-alias-state-success-primary)}
.mpi-state-off{color:var(--dsw-alias-label-secondary)}
.mpi-empty{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.mpi-error{margin:4px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px}
.mpi-headrow{display:flex;align-items:center;justify-content:space-between;gap:8px}
`;

    // ---- Client Remote contribution -------------------------------------------
    // The browser-side `remote.modelPromptInjector` service only exists after
    // this module mounts its namespace via ctx.remote.$mount(): dsh-api-remotes'
    // client assembly mounts only the official namespaces, so a plugin must
    // mount its own. Mirrors the invocations in typert.host.js. zod is not
    // requirable in the browser module loader, so codecs use passthrough
    // schemas — the runtime contract only requires typeSymbol + schema.parse().
    const passthrough = () => ({ parse: (v) => v });
    const result = (typeSymbol) => ({ mode: "strict", typeSymbol, schema: passthrough() });
    const CLIENT_REMOTE = {
      package: "dsh-model-prompt-injector",
      descriptors: [
        {
          id: "dsh-model-prompt-injector#modelPromptInjector/getState",
          service: "modelPromptInjector",
          namespace: "modelPromptInjector",
          method: "getState",
          invocation: { kind: "direct" },
          parameters: [],
          result: result("dsh-model-prompt-injector#ModelPromptInjectorStateResult"),
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
                schema: passthrough(),
              },
            },
          ],
          result: result("dsh-model-prompt-injector#ModelPromptInjectorSetRuleResult"),
        },
      ],
    };

    const SETTINGS_LABEL = "模型提示词";

    async function apply(ctx) {
      // Mount the modelPromptInjector namespace before anything touches it;
      // the mount's lifetime is bound to this plugin's context by $mount.
      await ctx.remote.$mount(CLIENT_REMOTE);

      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      // ctx.get() reads the service without the property-accessor inject guard.
      const remote = ctx.get("remote.modelPromptInjector");

      // ---- helpers ------------------------------------------------------------

      /**
       * The Remote gateway returns `res.value` = the Host method's full
       * `{ ok, value }` envelope; unwrap it (tolerate both shapes) and surface
       * either error layer.
       */
      function pick(res) {
        if (res && res.ok === false) {
          const err = res.error || {};
          throw new Error(err.message || err.code || "request failed");
        }
        const v = res && res.value;
        if (v && typeof v === "object" && v.ok === false) {
          const err = v.error || {};
          throw new Error(err.message || err.code || "request failed");
        }
        if (v && typeof v === "object" && v.ok === true) return v.value;
        return v;
      }

      const h = React.createElement;

      // ---- settings page (settings.section) -----------------------------------

      function Section() {
        const [state, setState] = React.useState({ loading: true, rules: [], providers: [], error: "" });

        const load = function () {
          remote
            .getState()
            .then((res) => {
              const value = pick(res) || {};
              setState({
                loading: false,
                rules: Array.isArray(value.rules) ? value.rules : [],
                providers: Array.isArray(value.providers) ? value.providers : [],
                error: "",
              });
            })
            .catch((e) => {
              setState({ loading: false, rules: [], providers: [], error: "读取配置失败：" + (e && e.message ? e.message : String(e)) });
            });
        };

        React.useEffect(load, []);

        let body;
        if (state.loading) {
          body = h("p", { className: "mpi-empty" }, "正在读取本地模型配置…");
        } else if (state.error) {
          body = h("p", { className: "mpi-error" }, state.error);
        } else if (state.providers.length === 0) {
          body = h("p", { className: "mpi-empty" }, "未找到本地已配置的服务商，请先在「模型」设置中添加服务商与模型。");
        } else {
          body = h("p", { className: "mpi-empty" }, "已加载 " + state.providers.length + " 个服务商。");
        }

        return h(
          "div",
          { className: "mpi-page" },
          h(
            "p",
            { className: "mpi-intro" },
            "为本地已配置的模型追加系统提示词：每次向该模型发起请求时，规则内容会注入到系统提示词的末尾。服务商级规则对该服务商的所有模型生效，并与模型级规则按顺序叠加。规则持久化保存，DSH 重启后仍然有效。",
          ),
          h(
            "div",
            { className: "mpi-headrow" },
            h("span", { className: "mpi-empty" }, state.loading ? "" : state.rules.length + " 条规则"),
            h(ui.Button, { variant: "ghost", size: "sm", onClick: load }, "刷新"),
          ),
          body,
        );
      }

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "model-prompt-injector", order: 12, label: () => SETTINGS_LABEL },
          () => h(Section),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return exports;
  },
});
