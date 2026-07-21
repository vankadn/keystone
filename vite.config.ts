import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/keystone/', // match your actual repo name exactly
  server: {
    port: 3000, // matches the origin already allowlisted for local dev (see CLAUDE.md Config)
    strictPort: true,
  },
})
