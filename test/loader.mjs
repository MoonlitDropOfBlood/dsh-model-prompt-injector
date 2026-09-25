// Redirects the three host package specifiers to local stubs for testing.
const redirects = {
  "@deepseek-ai/dsh-typert-protocol": "stubs/typert.mjs",
  "@deepseek-ai/cordis": "stubs/cordis.mjs",
  "@deepseek-ai/dsh-llm": "stubs/llm.mjs",
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(redirects, specifier)) {
    return {
      url: new URL(redirects[specifier], import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
