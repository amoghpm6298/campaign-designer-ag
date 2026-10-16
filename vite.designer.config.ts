/// <reference types="vitest/config" />
// Standalone Campaign Designer.
//
// Its own Vite config, entry point and port, deliberately separate from the
// ib-face-mock application's config. The two share source modules (the
// campaign graph, reducers, canvas, validators) but nothing of the UI shell:
// this app does not load ib-face-mock.html and has no Communication Hub.
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { agentApiPlugin } from './server/apiPlugin.ts'

export default defineConfig(({ mode }) => {
  // Server-side only. Nothing here is passed to `define`, so no secret can
  // reach the client bundle. A real shell variable wins over .env.
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
    if (!process.env[k]) process.env[k] = v
  }

  return {
    plugins: [react(), agentApiPlugin()],
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
