import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  server: {
    port: 4317,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
  },
});
