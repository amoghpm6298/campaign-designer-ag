/// <reference types="vitest/config" />
// Standalone Campaign Designer.
//
// Its own Vite config, entry point and port, deliberately separate from the
// ib-face-mock application's config. The two share source modules (the
// campaign graph, reducers, canvas, validators) but nothing of the UI shell:
// this app does not load ib-face-mock.html and has no Communication Hub.
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import { agentApiPlugin } from './server/apiPlugin.ts'

export default defineConfig(({ mode }) => {
  // Server-side only. Nothing here is passed to `define`, so no secret can
  // reach the client bundle. A real shell variable wins over .env.
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
    if (!process.env[k]) process.env[k] = v
  }

  return {
    // TAILWIND IS SCOPED TO THIS APP, deliberately. The designer is being
    // ported onto agent360's design system, and its components are Tailwind
    // utilities over that token set — with Tailwind here they port across;
    // without it every one has to be hand-translated and will drift. It is
    // additive: `vite.config.ts` and the drip-campaigns CSS are untouched.
    plugins: [react(), tailwindcss(), agentApiPlugin()],
    // Served at the root of its own port, so the tool has a direct URL and
    // does not sit under the mock app's /drip-campaigns/ subpath.
    base: '/',
    root: '.',
    server: { port: 5174 },
    preview: { port: 5174 },
    build: {
      outDir: 'dist-designer',
      rollupOptions: { input: 'designer.html' },
    },
  }
})
