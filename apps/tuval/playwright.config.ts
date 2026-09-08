/** Real browser journeys over isolated kernels; one worker keeps each harness deterministic. */

import {defineConfig, devices} from "@playwright/test";
import {COMMAND_CONTROL_PORT, CONTROL_PORTS} from "./src/page/proof/names.ts";

export default defineConfig({
	testDir: "./src/page/proof",
	testMatch: /.*\.spec\.ts$/,
	timeout: 60_000,
	expect: {timeout: 15_000},
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	workers: 1,
	reporter: "list",
	use: {
		...devices["Desktop Chrome"],
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: [
		...Object.values(CONTROL_PORTS).map((port) => ({
			command: `node src/page/proof/serve.ts --control-port ${port}`,
			url: `http://127.0.0.1:${port}/state`,
			reuseExistingServer: !process.env.CI,
			stdout: "pipe" as const,
			stderr: "pipe" as const,
			timeout: 180_000,
		})),
		{
			command: `node src/page/proof/command-serve.ts --control-port ${COMMAND_CONTROL_PORT}`,
			url: `http://127.0.0.1:${COMMAND_CONTROL_PORT}/state`,
			reuseExistingServer: !process.env.CI,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 180_000,
		},
	],
});
