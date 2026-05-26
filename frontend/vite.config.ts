import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8086',
      '/score-api': 'http://localhost:8086',
      '/rollcall-api': 'http://localhost:8086',
      '/downloads-api': 'http://localhost:8086',
    },
  },
})
