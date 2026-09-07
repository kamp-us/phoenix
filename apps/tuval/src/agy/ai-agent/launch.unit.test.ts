/**
 * The composed argv and the composed turn — the two things that reach agy, asserted without
 * spawning it.
 *
 * The flags are load-bearing in ways nothing observable catches later: a launch missing
 * `--add-dir` silently relocates the workspace, and a launch carrying
 * `--dangerously-skip-permissions` would be the posture ADR 0360 rejects. So they are pinned as a
 * whole array rather than probed one containment at a time.
 */

import {describe, expect, it} from "vitest";
import {AGY_EFFORTS, AGY_MODELS, AGY_MODES, AGY_SETTINGS_FILE, AGY_VERSION} from "../config.ts";
import {commandArgv, promptLine, sessionArgv} from "./launch.ts";
import {transcriptLogDir} from "./transcript.ts";

describe("the session argv", () => {
	it("is the whole launch, sandboxed and scoped to the workspace", () => {
		expect(sessionArgv({cwd: "/repo"})).toEqual([
			"--input-format=stream-json",
			"--output-format=stream-json",
			"--print=",
			"--sandbox",
			"--add-dir=/repo",
		]);
	});

	it("never composes the blanket-bypass flag, on any combination of options", () => {
		const every = [
			sessionArgv({cwd: "/repo"}),
			sessionArgv({cwd: "/repo", resume: "c-1", model: "m", mode: "plan", effort: "high"}),
			sessionArgv({cwd: "/repo", mode: "accept-edits"}),
		];
		expect(every.map((argv) => argv.join(" ")).join("\n")).not.toContain(
			"--dangerously-skip-permissions",
		);
	});

	it("carries the three switchable settings Go-style, before the sandbox pair", () => {
		expect(
			sessionArgv({cwd: "/repo", model: "claude-sonnet-4-6", mode: "plan", effort: "low"}),
		).toEqual([
			"--input-format=stream-json",
			"--output-format=stream-json",
			"--print=",
			"--model=claude-sonnet-4-6",
			"--mode=plan",
			"--effort=low",
			"--sandbox",
			"--add-dir=/repo",
		]);
	});

	it("resumes by conversation id", () => {
		expect(sessionArgv({cwd: "/repo", resume: "9dcbb5a5"})).toEqual([
			"--input-format=stream-json",
			"--output-format=stream-json",
			"--print=",
			"--sandbox",
			"--add-dir=/repo",
			"--conversation=9dcbb5a5",
		]);
	});
});

describe("a CLI-side command invocation", () => {
	it("is its own --print run in plain json, touching no conversation and no workspace", () => {
		expect(commandArgv("help")).toEqual(["--print=/help", "--output-format=json"]);
	});
});

describe("the composed turn", () => {
	it("is exactly one NDJSON line in the one shape agy reads", () => {
		const composed = promptLine("list the files");
		expect(composed).toEqual({
			kind: "line",
			line: '{"event":"user","message":{"content":"list the files"}}\n',
		});
	});

	it("keeps a multi-line prompt on one line, escaped rather than split", () => {
		const composed = promptLine("first\nsecond");
		expect(composed.kind).toBe("line");
		const line = composed.kind === "line" ? composed.line : "";
		expect(line.split("\n").filter((part) => part.length > 0)).toHaveLength(1);
		expect(JSON.parse(line)).toEqual({event: "user", message: {content: "first\nsecond"}});
	});

	it("round-trips a lone surrogate rather than writing a line that would kill the run", () => {
		const composed = promptLine("tail \ud800");
		expect(composed.kind).toBe("line");
		expect(JSON.parse(composed.kind === "line" ? composed.line : "null")).toEqual({
			event: "user",
			message: {content: "tail \ud800"},
		});
	});

	it("refuses an empty turn before anything reaches stdin", () => {
		expect(promptLine("   ")).toEqual({
			kind: "refused",
			detail: "an empty prompt is not a turn",
		});
	});
});

describe("the launch surface's constants", () => {
	it("pins one agy version for the whole module", () => {
		expect(AGY_VERSION).toBe("1.1.27");
	});

	it("offers the two modes agy's own --help names, and no third", () => {
		expect([...AGY_MODES]).toEqual(["accept-edits", "plan"]);
	});

	it("offers the three efforts /effort reports, and none of ThinkingLevel's other four", () => {
		expect([...AGY_EFFORTS]).toEqual(["low", "medium", "high"]);
	});

	it("names every catalog row with an id and a label", () => {
		expect(AGY_MODELS.filter((row) => row.id.length === 0 || row.name.length === 0)).toEqual([]);
		expect(new Set(AGY_MODELS.map((row) => row.id)).size).toBe(AGY_MODELS.length);
	});

	it("writes no absolute machine-local path — every vendor path is $HOME-relative", () => {
		// The reader's own path builder takes the home as an argument, and the settings path is a
		// relative fragment: neither can carry a machine the repo was written on.
		expect(AGY_SETTINGS_FILE.startsWith("/")).toBe(false);
		expect(transcriptLogDir("/anywhere", "c-1")).toBe(
			"/anywhere/.gemini/antigravity-cli/brain/c-1/.system_generated/logs",
		);
		expect(transcriptLogDir("/anywhere", "c-1")).toContain(AGY_SETTINGS_FILE.split("/settings")[0]);
	});
});
