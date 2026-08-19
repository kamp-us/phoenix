/**
 * Unit tier only: `packages/authz` is a pure mechanism with no storage to
 * integrate against — its adapters (`RelationStoreLive`, `CurrentActorLive`)
 * and their real-D1 tests live in `features/kunye`, not here.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
});
