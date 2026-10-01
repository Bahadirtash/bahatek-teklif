import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  base: "./",
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    outDir: "dist-web"
  }
});
