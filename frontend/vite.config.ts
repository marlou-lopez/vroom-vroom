import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Unused while VITE_API=mock; the real backend listens on 127.0.0.1:8765.
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
})
