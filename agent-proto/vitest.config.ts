/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// A separate vitest config so the agent-prototype tasks never run as part
// of `npm test`. Vitest is already a devDependency, so using it as the TS
// runner here adds no new dependency and reuses the app's own module
// resolution — which matters, since the app imports extensionlessly and
// plain `node file.ts` cannot resolve that.
export default defineConfig({
  test: {
    include: ['agent-proto/**/*.task.ts'],
    // Each task writes files and prints a report; no parallelism needed
    // and serial output is far easier to read.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
