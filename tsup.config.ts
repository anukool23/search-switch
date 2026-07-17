import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Backend clients are optional peer deps — never bundle them.
  // Only the driver the consumer actually installs gets loaded, at runtime.
  external: ["@opensearch-project/opensearch"],
});
