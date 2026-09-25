import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Deployed under /drip-campaigns/ on the same Vercel project as the
  // existing static prototype (index.html / ib-face-mock.html at the
  // root) — built asset URLs need to resolve under that subpath.
  base: '/drip-campaigns/',
})
