import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "src/assets/out",
    rollupOptions: {
      input: {
        svg: "src/styles/svg.css",
      },
      output: {
        assetFileNames: `[name].[ext]`,
      },
    },
  },
});
