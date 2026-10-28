import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // basicSsl serves the dev server over HTTPS with a self-signed certificate.
  // iPhones only allow live camera access (the Scan button) on HTTPS pages.
  // Your browser will warn about the certificate once - that's expected locally.
  plugins: [react(), basicSsl()],
  // Relative paths, so the built app works from any folder - including
  // GitHub Pages, which serves it from /CardGrader/ instead of /.
  base: './',
})
