/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
})
