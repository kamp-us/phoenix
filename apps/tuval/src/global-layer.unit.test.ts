/**
 * The repo's committed global layer (#9694): the four harness rows live there and not in Tuval's
 * project config, every one takes its folder at start, and `pnpm dev` boots with it. The rows are
 * read off the module rather than booted, because a spawn of any of them stands a real agent up.
 */

import {readFileSync} from "node:fs";
import {describe, expect, it} from "@effect/vitest";
import {AGY_SESSION_PROGRAM} from "@kampus/tuval-agy";
import {CLAUDE_SESSION_PROGRAM} from "@kampus/tuval-claude";
import {CODEX_SESSION_PROGRAM} from "@kampus/tuval-codex";
import {PI_SESSION_PROGRAM} from "@kampus/tuval-pi";
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import project from "../.tuval/tuval.config.ts";
import global from "../global/tuval.config.ts";
import {programEntries} from "./shell/picker/entries.ts";

const HARNESSES = [
	PI_SESSION_PROGRAM,
	CLAUDE_SESSION_PROGRAM,
	AGY_SESSION_PROGRAM,
	CODEX_SESSION_PROGRAM,
];

const rowsOf = (config: {readonly programs: ReadonlyArray<unknown>}) =>
	config.programs as ReadonlyArray<AnyProgram>;

describe("the committed global layer", () => {
	it("holds all four harness rows, each taking its folder at start", () => {
		const rows = rowsOf(global);
		expect(rows.map((row) => row.id)).toEqual(HARNESSES);
		for (const row of rows) expect(row.folderAtStart).toBe(true);
	});

	it("leaves no harness row in Tuval's project config", () => {
		const ids = rowsOf(project).map((row) => row.id as string);
		for (const harness of HARNESSES) expect(ids).not.toContain(harness);
	});

	it("is what `pnpm dev` boots with, so the dev desk offers all four", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as {readonly scripts: Readonly<Record<string, string>>};
		expect(manifest.scripts.dev).toBe("node src/bin.ts --config global/tuval.config.ts");
		expect(new Set(programEntries(rowsOf(global)).map((entry) => entry.programId))).toEqual(
			new Set(HARNESSES),
		);
	});
});
