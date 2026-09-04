import {defineConfig} from "vitest/config";

// Two projects (#7544): `unit` for everything that needs no process outside this one, and
// `integration` for the suites that stand a real Pi `AgentSession` up on a real loopback socket
// (#7567). Tuval's integration tier is slow, not remote — it needs no cloud credentials.
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
					testTimeout: 60_000,
				},
			},
		],
	},
});
