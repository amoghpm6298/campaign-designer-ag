/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { agentApiPlugin } from './server/apiPlugin.ts'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env into process.env for the SERVER side only. The '' prefix loads
  // every key including ANTHROPIC_API_KEY — safe because this assignment
  // happens in the Vite config (Node), and nothing here is passed to
  // `define`, so no secret can reach the client bundle.
  //
  // A real shell variable WINS over .env. Without this, the placeholder in a
  // copied .env would silently overwrite a key exported in the shell, which
  // makes `ANTHROPIC_API_KEY=... npm run dev` appear to fail for no visible
  // reason — the hardest kind of configuration bug to diagnose.
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
    if (!process.env[k]) process.env[k] = v
  }

  return {
  plugins: [react(), agentApiPlugin()],
  // Deployed under /drip-campaigns/ on the same Vercel project as the
  // existing static prototype (index.html / ib-face-mock.html at the
  // root) — built asset URLs need to resolve under that subpath.
  base: '/drip-campaigns/',
  test: {
    // Vitest's default include glob also matches tests/e2e/*.spec.ts —
    // those are real @playwright/test files (run via `npx playwright
    // test`, not vitest) and fail immediately under vitest's runtime
    // since Playwright's own test()/expect() aren't compatible with it.
    // Scope vitest to the unit suite only.
    include: ['tests/unit/**/*.test.ts'],
  },
  }
})
