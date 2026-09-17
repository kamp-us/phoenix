import {fileURLToPath} from "node:url";
import {defineConfig} from "vitest/config";

export default defineConfig({
	resolve: {
		// The fixture `.tuval/tuval.config.ts` imports this package by name, as a user's config does.
		// The alias points that name at the public entry in source — the same module the published
		// `exports` map reaches through `dist` — so the suite runs without a build step and still
		// reaches nothing but the entry.
		alias: {
			"@kampus/tuval-cron": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
		},
		// One `effect`, said out loud. `@kampus/tuval` is a workspace dependency on the same
		// root `catalog:` pin this package holds, so the suite already gets one instance — this line is
		// belt and braces here. It stays because it stops being that the moment this package is
		// consumed from npm beside a Tuval that is not hoisted with it: two instances mean a `Schema`
		// built by one is a stranger to a decoder from the other, which is how `:cron run`'s args
		// decoded to `Symbol()` instead of `{}` before this line existed.
		dedupe: ["effect", "@demlik/tea"],
	},
	test: {
		globals: true,
	},
});
