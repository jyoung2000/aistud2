import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and serves the built `dist/` in production.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "dist",
    rollupOptions: {
      output: {
        // keep every chunk under the 500 kB warning: the canvas engine (konva) and the
        // react runtime split out of the app chunk and load in parallel
        manualChunks: {
          konva: ["konva", "react-konva"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
