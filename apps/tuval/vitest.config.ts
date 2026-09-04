import {defineConfig} from "vitest/config";

// A `unit` project so `vitest --project unit` (the pre-push `unit-changed` leg over `apps/**`)
// resolves here, and an `integration` project beside it now that the app has one: the transport's
// proof binds a real loopback socket, which is the second tier's whole definition (#7544, #7556).
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.unit.test.ts"],
				},
			},
			{
				test: {
					name: "integration",
					include: ["src/**/*.integration.test.ts"],
				},
			},
		],
	},
});
