import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
