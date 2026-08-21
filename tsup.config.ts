import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/retriever.ts"],
  format: ["cjs", "esm"],
  target: "es2022",
  clean: true,
  dts: true,
  minify: false,
  sourcemap: true,
  splitting: false,
  external: ["@voltagent/core", "couchbase"],
  esbuildOptions(options) {
    options.keepNames = true;
  },
});
