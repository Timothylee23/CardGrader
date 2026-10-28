import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative paths, so the built app works from any folder - including
  // GitHub Pages, which serves it from /CardGrader/ instead of /.
  base: './',
})
