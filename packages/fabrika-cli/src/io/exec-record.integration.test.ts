import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {execRecord} from "./exec.ts";

describe("execRecord", () => {
	it.each([
		{name: "the direct child is still running", command: "printf partial-output; sleep 5"},
		{
			name: "an exited child left a descendant holding the streams",
			command: "printf partial-output; (sleep 5) &",
		},
	])("kills the process group at its timeout when $name", async ({command}) => {
		const startedAt = performance.now();
		const outcome = await Effect.runPromise(
			Effect.provide(
				execRecord({
					file: "/bin/sh",
					args: ["-c", command],
					cwd: process.cwd(),
					env: {},
					timeoutSeconds: 0.1,
					captureBytes: 1_024,
				}),
				NodeServices.layer,
			),
		);
		const elapsedMs = performance.now() - startedAt;

		expect(outcome).toMatchObject({
			_tag: "Ran",
			exitCode: null,
			timedOut: true,
			truncated: false,
		});
		if (outcome._tag === "Ran") {
			expect(new TextDecoder().decode(outcome.stdout)).toBe("partial-output");
		}
		expect(elapsedMs).toBeLessThan(2_000);
	});
});
