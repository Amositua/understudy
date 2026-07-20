import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: "src/sidepanel/index.html",
        background: "src/background/service-worker.ts",
        content: "src/content/content.ts"
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background/service-worker.js";
          if (chunk.name === "content") return "content/content.js";
          return "assets/[name]-[hash].js";
        }
      }
    }
  }
});
