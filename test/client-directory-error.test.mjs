/**
 * Client-half behavioral test: the Host's `directoryError` must REACH the
 * user. Run: `node test/client-directory-error.test.mjs`.
 *
 * The plugin's client half is a browser bundle (`window.__ModuleLoader__.load`),
 * so it is loaded here against a stub DOM and a MINIMAL React runtime: React
 * is not a dependency of this repo (and not resolvable from the host install
 * either), so the test supplies just enough of the hook API
 * (`createElement` / `useState` / `useEffect`) to render the settings section
 * and observe the produced element tree.
 *
 * What is asserted here:
 *   1. `directoryError` flows from `getState()` through `pick()` into the
 *      component state (it used to be dropped: load() only read `rules` and
 *      `providers`);
 *   2. an empty provider list WITH a directoryError shows the REASON, not the
 *      misleading "未找到本地已配置的服务商，请先在「模型」设置中添加服务商与模型。";
 *   3. a partial failure (providers present + directoryError) shows a warning
 *      banner AND still lists the providers;
 *   4. the healthy path is unchanged (no banner, no reason, providers listed);
 *   5. an empty provider list WITHOUT a reason keeps the original hint;
 *   6. saving a rule must not wipe the directory verdict.
 */
import assert from "node:assert/strict";

// ---- minimal React runtime ---------------------------------------------------

/**
 * A tiny hook runtime: state persists across re-renders, `setState` triggers a
 * re-render, and `useEffect` callbacks are collected so the test can flush
 * them (the settings section loads its state in an effect).
 */
function makeReact() {
  let hooks = [];
  let hookIndex = 0;
  let effects = [];
  let rerender = null;
  const React = {
    createElement(type, props, ...children) {
      const p = Object.assign({}, props || {});
      // Real React exposes the children through props as well; the plugin's
      // Button stub relies on it, so mirror that here.
      if (children.length > 0) p.children = children.length === 1 ? children[0] : children;
      return { type, props: p, children };
    },
    useState(initial) {
      const index = hookIndex++;
      if (hooks.length <= index) {
        hooks[index] = typeof initial === "function" ? initial() : initial;
      }
      const set = (next) => {
        const value = typeof next === "function" ? next(hooks[index]) : next;
        hooks[index] = value;
        if (rerender) rerender();
      };
      return [hooks[index], set];
    },
    useEffect(fn) {
      effects.push(fn);
    },
  };
  return {
    React,
    /** Render a component element and return its element tree. */
    render(element) {
      hookIndex = 0;
      const tree = element.type(element.props || {});
      rerender = () => {
        hookIndex = 0;
        element.type(element.props || {});
      };
      return tree;
    },
    flushEffects() {
      const pending = effects;
      effects = [];
      for (const fn of pending) fn();
    },
  };
}

/**
 * Concatenate every text node of an element tree. Component elements are
 * rendered on the way (the tree holds element descriptors, not DOM nodes), so
 * nested components (ProviderCard / RuleRow / RuleEditor) contribute their
 * text too.
 */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node.type === "function") return textOf(node.type(node.props || {}));
  if (node.children) return node.children.map(textOf).join("");
  return "";
}

/** Every element in the tree, depth first, with components rendered. */
function elementsOf(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out);
    return out;
  }
  if (typeof node.type === "function") {
    elementsOf(node.type(node.props || {}), out);
    return out;
  }
  out.push(node);
  for (const child of node.children || []) elementsOf(child, out);
  return out;
}

// ---- stub browser -------------------------------------------------------------

const styleTags = [];
let clientRegistration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      clientRegistration = registration;
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

const { React, render, flushEffects } = makeReact();

// Import the client bundle AFTER the stub globals are in place (a static
// import would be hoisted above them and the bundle would see a bare DOM).
await import("../client.js");

const clientExports = clientRegistration.factory((specifier) => {
  if (specifier === "react") return React;
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
    // Render the official Button as a real <button> so the test can click it.
    return {
      Button: (props) => React.createElement("button", props, props.children),
    };
  }
  throw new Error(`unexpected client require: ${specifier}`);
});

// ---- mount the client half ----------------------------------------------------

const slotRegistrations = [];
/** The state the fake Host reports; each test replaces it. */
let hostState = { rules: [], providers: [] };
const remoteStub = {
  getState: async () => ({ ok: true, value: hostState }),
  setRule: async () => ({ ok: true, value: { rules: [] } }),
};

await clientExports.apply({
  remote: { $mount: async () => () => {} },
  get: () => remoteStub,
  effect: (fn) => {
    const dispose = fn();
    if (typeof dispose === "function") dispose();
  },
  slots: {
    inject: (name, register) => {
      if (name !== "settings.section.icon") register();
      return () => {};
    },
    register: (descriptor, render2) => slotRegistrations.push({ descriptor, render: render2 }),
  },
});

const section = slotRegistrations.find((r) => r.descriptor.name === "settings.section");
assert.ok(section, "the plugin never registered a settings.section");

/** Render the settings page against the given Host state and return the tree. */
async function renderPage(state) {
  hostState = state;
  const element = section.render();
  const tree = render(element);
  flushEffects();                            // runs the load() effect
  await new Promise((r) => setTimeout(r, 0)); // let the getState promise settle
  return render(element);                    // re-render with the loaded state
}

const PROVIDER_OK = {
  provider: "minimax-cn",
  displayName: "MiniMax",
  active: true,
  models: [{ id: "M3", name: "M3" }],
};

// ---- 1. the reason reaches the user (empty directory) -------------------------

{
  const tree = await renderPage({
    rules: [],
    providers: [],
    directoryError: "llm 服务不可用：宿主未挂载 llm 服务，无法读取服务商与模型目录",
  });
  const text = textOf(tree);
  assert.ok(
    text.includes("无法读取服务商目录：llm 服务不可用"),
    "the Host's reason must be shown to the user",
  );
  assert.ok(
    !text.includes("未找到本地已配置的服务商"),
    "the misleading 'no provider configured' hint must NOT be shown when the read failed",
  );
  const errorNode = elementsOf(tree).find((n) => n.props && n.props.className === "mpi-error");
  assert.ok(errorNode, "the reason is rendered with the mpi-error style");
  console.log("  ok 1 empty directory + directoryError -> the reason is shown (not the misleading hint)");
}

// ---- 2. partial failure: banner + providers still listed ----------------------

{
  const tree = await renderPage({
    rules: [],
    providers: [PROVIDER_OK, { provider: "broken", displayName: "Broken", active: true, models: [] }],
    directoryError: "服务商 broken 的模型列表读取失败：catalog timeout",
  });
  const text = textOf(tree);
  assert.ok(text.includes("服务商目录部分读取失败"), "a partial failure is announced");
  assert.ok(text.includes("broken"), "the banner names the failing provider");
  assert.ok(text.includes("catalog timeout"), "the banner carries the Host's message");
  assert.ok(text.includes("minimax-cn"), "the healthy provider is still listed");
  const warnNode = elementsOf(tree).find((n) => n.props && n.props.className === "mpi-warn");
  assert.ok(warnNode, "the partial-failure banner uses the mpi-warn style");
  console.log("  ok 2 partial failure -> warning banner + the other providers still listed");
}

// ---- 3. the healthy path is unchanged ------------------------------------------

{
  const tree = await renderPage({ rules: [], providers: [PROVIDER_OK] });
  const text = textOf(tree);
  assert.ok(!text.includes("无法读取服务商目录"), "no reason on the healthy path");
  assert.ok(!text.includes("服务商目录部分读取失败"), "no banner on the healthy path");
  assert.ok(text.includes("minimax-cn"), "the provider is listed");
  const classes = elementsOf(tree).map((n) => n.props && n.props.className).filter(Boolean);
  assert.ok(!classes.includes("mpi-warn"), "no warning node on the healthy path");
  assert.ok(!classes.includes("mpi-error"), "no error node on the healthy path");
  console.log("  ok 3 healthy path -> no banner, no reason, providers listed");
}

// ---- 4. an empty provider list WITHOUT a reason keeps the original hint --------

{
  const tree = await renderPage({ rules: [], providers: [] });
  const text = textOf(tree);
  assert.ok(
    text.includes("未找到本地已配置的服务商"),
    "with no reason at all the original hint stays (the user really configured nothing)",
  );
  console.log("  ok 4 empty directory without a reason -> the original hint is kept");
}

// ---- 5. saving a rule must not wipe the directory verdict -----------------------

{
  hostState = {
    rules: [],
    providers: [PROVIDER_OK],
    directoryError: "服务商 broken 的模型列表读取失败：catalog timeout",
  };
  const element = section.render();
  render(element);
  flushEffects();
  await new Promise((r) => setTimeout(r, 0));
  render(element);

  // Open one rule row (the "添加提示词" button of the provider-wide row).
  const openButton = elementsOf(render(element)).find(
    (n) => n.type === "button" && n.children && n.children[0] === "添加提示词",
  );
  assert.ok(openButton, "the provider card has an 'add prompt' button");
  openButton.props.onClick();
  render(element);

  // Save the (empty) prompt: the fake Remote answers with an empty rule table.
  const saveButton = elementsOf(render(element)).find(
    (n) => n.type === "button" && n.children && n.children[0] === "保存",
  );
  assert.ok(saveButton, "the opened editor has a save button");
  saveButton.props.onClick();
  await new Promise((r) => setTimeout(r, 0));

  const text = textOf(render(element));
  assert.ok(
    text.includes("服务商目录部分读取失败"),
    "saving a rule must not drop the directory reason",
  );
  console.log("  ok 5 saving a rule keeps the directory reason visible");
}

console.log("client-directory-error.test: ALL PASS");
