import { defineConfig } from "vite";

export default defineConfig({
  esbuild: {
    minifyIdentifiers: false,
    keepNames: true,
  },
  build: {
    cssCodeSplit: true,
    lib: {
      entry: ["src/export/index.ts"],
      formats: ["es"],
    },
    outDir: "src/assets/out",
  },
});
