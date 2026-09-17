import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The fixture `.tuval/tuval.config.ts` and the composition test import this package by name, as
    // a user's config does. The alias points that name at the public entry in source — the same
    // module the published `exports` map reaches through `dist` — so the suite runs without a build
    // step and still reaches nothing but the entry. `@kampus/tuval-cron` needs no line here: it is a
    // workspace dependency whose own `development` export condition already resolves to its source.
    alias: {
      "@kampus/tuval-shell": fileURLToPath(
        new URL("./src/index.ts", import.meta.url),
      ),
    },
    // One `effect`, said out loud. `@kampus/tuval` is a workspace dependency on the same
    // `catalog:tuval` pin this package holds, so the suite already gets one instance — this line is
    // belt and braces here. It stays because it stops being that the moment this package is consumed
    // from npm beside a Tuval that is not hoisted with it: two instances mean a `Schema` built by one
    // is a stranger to a decoder from the other.
    dedupe: ["effect"],
  },
  test: {
    globals: true,
  },
});
