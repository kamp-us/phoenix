import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {execRecord, POST_KILL_STREAM_DRAIN_GRACE_MS} from "./exec.ts";

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

	it("bounds stream draining when a detached descendant inherits both output pipes", async () => {
		const root = await mkdtemp(join(tmpdir(), "exec-record-detached-"));
		const descendantPidPath = join(root, "descendant.pid");
		const script = [
			'const {spawn} = require("node:child_process");',
			'const {writeFileSync} = require("node:fs");',
			'process.stdout.write(String(process.pid) + "\\npartial-output");',
			'process.stderr.write("partial-error");',
			'const descendant = spawn("/bin/sh", ["-c", "sleep 10"], {detached: true, stdio: ["ignore", "inherit", "inherit"]});',
			`writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
			"descendant.unref();",
			"setInterval(() => undefined, 1_000);",
		].join("\n");
		let descendantPid: number | undefined;
		try {
			const startedAt = performance.now();
			const outcome = await Effect.runPromise(
				Effect.provide(
					execRecord({
						file: process.execPath,
						args: ["-e", script],
						cwd: process.cwd(),
						env: {},
						timeoutSeconds: 0.1,
						captureBytes: 1_024,
					}),
					NodeServices.layer,
				),
			);
			const elapsedMs = performance.now() - startedAt;
			descendantPid = Number((await readFile(descendantPidPath, "utf8")).trim());

			expect(outcome).toMatchObject({
				_tag: "Ran",
				exitCode: null,
				timedOut: true,
				truncated: false,
				timeoutDiagnostic: `process-group SIGKILL sent after 0.1s; stream drain exceeded ${POST_KILL_STREAM_DRAIN_GRACE_MS}ms and readers were interrupted`,
			});
			if (outcome._tag !== "Ran") return;
			const stdout = new TextDecoder().decode(outcome.stdout);
			const [primaryPidText] = stdout.split("\n");
			const primaryPid = Number(primaryPidText);
			expect(stdout).toContain("partial-output");
			expect(new TextDecoder().decode(outcome.stderr)).toBe("partial-error");
			expect(elapsedMs).toBeLessThan(1_500);
			expect(() => process.kill(primaryPid, 0)).toThrow();
		} finally {
			const recordedPid = await Effect.runPromise(
				Effect.tryPromise({
					try: () => readFile(descendantPidPath, "utf8"),
					catch: () => "the descendant PID was not recorded" as const,
				}).pipe(Effect.orElseSucceed(() => null)),
			);
			const pid = descendantPid ?? (recordedPid === null ? undefined : Number(recordedPid.trim()));
			if (pid !== undefined && Number.isInteger(pid)) {
				Effect.runSync(
					Effect.try({
						try: () => process.kill(-pid, "SIGKILL"),
						catch: () => "the detached test process already exited" as const,
					}).pipe(Effect.ignore),
				);
			}
			await rm(root, {recursive: true, force: true});
		}
	});
});
