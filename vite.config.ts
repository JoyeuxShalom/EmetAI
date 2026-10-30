import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Stamped into the bundle so a running Studio can tell whether it is the
    // version the server is now serving. An operator keeps this tab open for
    // hours; after a deploy it goes on running the old code in memory, and a
    // fix that has shipped simply appears not to work. See src/lib/version.ts.
    __BUILD_ID__: JSON.stringify(
      new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
    ),
  },
  server: {
    proxy: {
      // EmetAI backend: auth, subscriptions, admin, clipper, and the AI ear (ws).
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        ws: true,
      },
      '/yv': {
        target: 'https://api.youversion.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yv/, ''),
      },
    },
  },
})
