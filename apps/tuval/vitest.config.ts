import {defineConfig} from "vitest/config";

// One `unit` project so `vitest --project unit` (the pre-push `unit-changed` leg over
// `apps/**`) resolves here; an `integration` project joins when the app has one. See #7544.
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.unit.test.ts"],
				},
			},
		],
	},
});
