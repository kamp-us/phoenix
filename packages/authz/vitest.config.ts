/**
 * Vitest config — `packages/authz` is a pure mechanism (no DB, no worker), so
 * every test is a colocated `*.unit.test.ts` of a pure primitive (the Grant
 * seal, the Level ordering, Resource ancestry/covers, the class-builders'
 * exhaustive Actor dispatch + Grant provision into context). No integration
 * tier: the package names no storage to integrate against — its adapters
 * (`RelationStoreLive`, `CurrentActorLive`) and their real-D1 tests live in
 * `features/kunye`, not here.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
});
