import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {ChildOutcome} from "../io/exec.ts";
import {formatDockerReadinessFailure, waitForDockerReadiness} from "./ci-produce-readiness.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const ran = (
	stdout = "",
	stderr = "",
	overrides: Partial<Extract<ChildOutcome, {readonly _tag: "Ran"}>> = {},
): ChildOutcome => ({
	_tag: "Ran",
	exitCode: 0,
	timedOut: false,
	truncated: false,
	stdout: bytes(stdout),
	stderr: bytes(stderr),
	...overrides,
});
const inspect = (running: boolean, exitCode = 0): ChildOutcome =>
	ran(
		JSON.stringify({
			id: "container-id",
			name: "/container-name",
			image: "fixture-image",
			state: {
				Status: running ? "running" : "exited",
				Running: running,
				ExitCode: exitCode,
				Error: "",
			},
		}),
	);

const wait = (
	outcomes: ChildOutcome[],
	timing: {readonly deadlineMs?: number; readonly pollIntervalMs?: number} = {},
) => {
	let now = 0;
	const calls: string[] = [];
	const timeouts: number[] = [];
	const sleeps: number[] = [];
	const result = Effect.runSync(
		waitForDockerReadiness({
			containerId: "container-id",
			containerName: "container-name",
			readinessPattern: /fixture ready/,
			run: (args, timeoutSeconds) =>
				Effect.sync(() => {
					calls.push(args[0] ?? "");
					timeouts.push(timeoutSeconds);
					const outcome = outcomes.shift();
					if (outcome === undefined) throw new Error(`unexpected Docker call ${args.join(" ")}`);
					return outcome;
				}),
			now: () => now,
			sleep: (milliseconds) =>
				Effect.sync(() => {
					sleeps.push(milliseconds);
					now += milliseconds;
				}),
			...timing,
		}),
	);
	return {result, calls, timeouts, sleeps, remaining: outcomes};
};

describe("Docker readiness state machine", () => {
	it("tolerates empty logs while running and becomes ready on the declared line", () => {
		const observed = wait([ran(), inspect(true), ran("fixture ready\n"), inspect(true)]);
		expect(observed.result._tag).toBe("Ready");
		expect(observed.calls).toEqual(["logs", "inspect", "logs", "inspect"]);
		expect(observed.sleeps).toEqual([250]);
		expect(observed.remaining).toEqual([]);
		if (observed.result._tag === "Ready") {
			expect(observed.result.observation.logs).toMatchObject({stdout: bytes("fixture ready\n")});
			expect(observed.result.observation.state).toMatchObject({
				id: "container-id",
				name: "/container-name",
				running: true,
			});
		}
	});

	it("records empty logs, exact identity, and exit code when the container exits", () => {
		const observed = wait([ran(), inspect(true), ran(), inspect(false, 17)]);
		expect(observed.result._tag).toBe("Exited");
		expect(observed.sleeps).toEqual([250]);
		if (observed.result._tag === "Exited") {
			expect(observed.result.observation.logs).toMatchObject({
				stdout: bytes(""),
				stderr: bytes(""),
			});
			expect(observed.result.observation.state).toMatchObject({
				id: "container-id",
				name: "/container-name",
				exitCode: 17,
				running: false,
			});
			expect(formatDockerReadinessFailure(observed.result)).toContain("stdoutBytes=0");
			expect(formatDockerReadinessFailure(observed.result)).toContain("exitCode=17");
		}
	});

	it("stops at the bounded deadline with the last running inspect and log bytes", () => {
		const observed = wait(
			[ran(), inspect(true), ran("booting"), inspect(true), ran("still booting"), inspect(true)],
			{
				deadlineMs: 500,
				pollIntervalMs: 250,
			},
		);
		expect(observed.result._tag).toBe("TimedOut");
		expect(observed.sleeps).toEqual([250, 250]);
		expect(observed.timeouts.every((seconds) => seconds > 0 && seconds <= 1)).toBe(true);
		expect(observed.remaining).toEqual([]);
		if (observed.result._tag === "TimedOut") {
			expect(observed.result.observation.observedAtMs).toBe(500);
			expect(observed.result.observation.state).toMatchObject({running: true, exitCode: 0});
			expect(formatDockerReadinessFailure(observed.result)).toContain('stdout="still booting"');
		}
	});

	it("fails a log read without polling again but still inspects and retains both diagnostics", () => {
		const logFailure = ran("partial-out", "daemon unavailable", {exitCode: 1});
		const observed = wait([logFailure, inspect(true)]);
		expect(observed.result._tag).toBe("ObservationFailed");
		expect(observed.calls).toEqual(["logs", "inspect"]);
		expect(observed.sleeps).toEqual([]);
		if (observed.result._tag === "ObservationFailed") {
			expect(observed.result.phase).toBe("logs");
			expect(observed.result.observation.state).toMatchObject({running: true});
			const diagnostic = formatDockerReadinessFailure(observed.result);
			expect(diagnostic).toContain("phase=logs");
			expect(diagnostic).toContain('stdout="partial-out"');
			expect(diagnostic).toContain('stderr="daemon unavailable"');
			expect(diagnostic).toContain('observedId="container-id"');
		}
	});
});
