/**
 * The browser tier for `apps/tuval`: `pnpm test:browser` from this directory.
 *
 * There is one journey here and it is the page's recovery from a dropped socket, so the config is
 * the smallest one that runs it honestly. Each `webServer` entry is one proof harness
 * (`src/page/proof/serve.ts`) and the wait is on its control endpoint — a harness boots a kernel and
 * chats a Pi session before it answers, so no spec can start against a half-booted desk.
 *
 * **One harness per test** (`src/page/proof/names.ts` says why), and `workers: 1` for that from the
 * other side: a harness is one kernel with one Pi session, so two specs driving it at once would be
 * two tests sharing one transcript. Traces and screenshots are kept on failure because a red here is
 * a browser-only fact — there is no other tier that can show what the page looked like.
 */

import {defineConfig, devices} from "@playwright/test";
import {CONTROL_PORTS} from "./src/page/proof/names.ts";

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
	webServer: Object.values(CONTROL_PORTS).map((port) => ({
		command: `node src/page/proof/serve.ts --control-port ${port}`,
		url: `http://127.0.0.1:${port}/state`,
		reuseExistingServer: !process.env.CI,
		stdout: "pipe" as const,
		stderr: "pipe" as const,
		timeout: 180_000,
	})),
});
