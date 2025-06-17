import { defineConfig } from "vite";

export default defineConfig({
  esbuild: {
    minifyIdentifiers: false,
    keepNames: true,
  },
  build: {
    outDir: "src/assets/out",
    rollupOptions: {
      input: {
        style: "src/styles/svg.css",
        callgraph: "src/graph/CallGraph.ts",
      },
      output: {
        entryFileNames: `[name].js`,
        chunkFileNames: `[name].js`,
        assetFileNames: `[name].[ext]`,
      },
    },
  },
});
