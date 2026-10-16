// Lets `node --experimental-strip-types` follow this repo's extensionless
// imports ("./anthropic" -> anthropic.ts). Vite and vitest resolve those for
// us; plain node does not, and the evaluation runner is deliberately run
// outside both so it exercises the real server modules directly.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return await next(specifier + ext, context);
        } catch {
          /* try the next extension */
        }
      }
    }
    throw e;
  }
}
