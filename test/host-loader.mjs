// Resolves the plugin's bare `@deepseek-ai/cordis` / `@deepseek-ai/dsh-*`
// imports to the REAL host installation, so the e2e exercises the plugin
// against the exact runtime DSH loads.
//
// Two host generations, two anchors:
//   - DSH ≤ 0.1.x: every profile's node_modules is a junction farm into the
//     running host's copy, so resolving from a profile manifest lands on the
//     live host packages.
//   - DSH 0.2.0-rc.1+: profiles no longer carry @deepseek-ai host packages
//     (`nodeLinker: hoisted`, `autoInstallPeers: false`); the host runs from
//     the desktop installation and intercepts plugin module resolution the
//     same way (dsh-app-boot `installRuntimeInterception`). The equivalent
//     anchor here is the running core's own package.json inside the desktop
//     app data directory.
//
// The first anchor that can actually resolve a representative host package
// wins, so each generation keeps resolving its own consistent copy.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A package every generation of the host ships and this plugin imports. */
const PROBE_SPECIFIER = "@deepseek-ai/dsh-typert-protocol";

/** Candidate anchors, most specific first. */
function hostAnchors() {
  const anchors = [];
  if (process.env.DSH_HOST_MODULES) anchors.push(process.env.DSH_HOST_MODULES);
  const profiles = join(homedir(), ".dsh", "profiles");
  const names = existsSync(profiles) ? readdirSync(profiles, { withFileTypes: true }) : [];
  for (const entry of names) {
    if (entry.isDirectory()) anchors.push(join(profiles, entry.name, "package.json"));
  }
  // Desktop installation: the app data checkout the desktop core spawns from
  // (`.../dsh/node_modules/@deepseek-ai/dsh`), and the packaged-resources
  // layout as a fallback for non-default install roots.
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  anchors.push(join(appData, "DeepSeek Harness Desktop", "dsh", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  anchors.push(join(homedir(), "AppData", "Local", "Programs", "DeepSeek Harness Desktop", "resources", "dsh", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  return anchors.filter((anchor) => existsSync(anchor));
}

/** First anchor whose resolution paths reach a real copy of the probe package. */
function hostAnchor() {
  for (const anchor of hostAnchors()) {
    try {
      createRequire(anchor).resolve(PROBE_SPECIFIER);
      return anchor;
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(
    "host-loader: no anchor can resolve " + PROBE_SPECIFIER +
    "; set DSH_HOST_MODULES to a directory whose node_modules holds @deepseek-ai/*",
  );
}

const resolvedAnchor = hostAnchor();
const hostRequire = createRequire(resolvedAnchor);

/**
 * The resolved host anchor (a package.json path) and a require bound to it.
 * The e2e reuses these to read host sources (SECTION_ORDERS, versions) from
 * the exact same copy the loader hooks import.
 */
export const hostAnchorPath = resolvedAnchor;
export { hostRequire };

/** Whether a specifier is one of the host packages a plugin links against. */
function isHostSpecifier(specifier) {
  return specifier === "@deepseek-ai/cordis" || specifier.startsWith("@deepseek-ai/dsh-");
}

export async function resolve(specifier, context, nextResolve) {
  if (isHostSpecifier(specifier)) {
    try {
      return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true };
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  return nextResolve(specifier, context);
}
