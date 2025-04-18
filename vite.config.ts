// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  // No special plugins needed for basic TS, CSS, and static asset handling.
  // Vite uses the project root and finds index.html by default.
  build: {
    outDir: "dist",
    // Generate source maps for the production build
    sourcemap: true,
  },
  server: {
    // Port for the dev server
    port: 8080,
    // Open the browser automatically when starting the dev server (optional)
    open: true,
  },
  // Ensure pdf.js worker is handled correctly if needed,
  // but often not necessary if using the CDN worker source directly in JS.
  // optimizeDeps: {
  //   exclude: ['pdfjs-dist'] // Might be needed if you import pdfjs-dist differently
  // }
});

