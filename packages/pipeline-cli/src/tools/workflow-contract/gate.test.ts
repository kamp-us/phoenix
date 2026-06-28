import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {type CheckFailed, checkWorkflows, scanWorkflowScripts} from "./gate.ts";

/** A throwaway repo root carrying `.claude/workflows/<name>.js` scripts. */
const makeRepo = (scripts: Record<string, string>): string => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-contract-"));
	const wf = join(dir, ".claude", "workflows");
	mkdirSync(wf, {recursive: true});
	for (const [name, content] of Object.entries(scripts)) {
		writeFileSync(join(wf, name), content, "utf8");
	}
	return dir;
};

const CONFORMANT = `export const meta = {
	name: "drive-issue",
	description: "drive one issue",
	phases: ["Run"],
};
phase("Run");
await agent("x", {});
`;

describe("scanWorkflowScripts", () => {
	it("finds and judges each .claude/workflows/*.js (ignoring non-.js)", async () => {
		const dir = makeRepo({
			"good.js": CONFORMANT,
			"bad.js": "export default async function () {}",
			"README.md": "not a script",
		});
		try {
			const verdicts = await Effect.runPromise(scanWorkflowScripts(dir));
			assert.deepStrictEqual(verdicts.map((v) => v.file).sort(), [
				".claude/workflows/bad.js",
				".claude/workflows/good.js",
			]);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);
});

describe("checkWorkflows", () => {
	it("passes on a conformant drive-issue-shaped script", async () => {
		const dir = makeRepo({"drive-issue.js": CONFORMANT});
		try {
			const exit = await Effect.runPromiseExit(checkWorkflows(dir));
			assert.isTrue(Exit.isSuccess(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails CheckFailed on an export-default (#1217-shape) script", async () => {
		const dir = makeRepo({
			"bad.js": `export default async function ({ agent, args, phase, log }) {}`,
		});
		try {
			const reason = await Effect.runPromise(
				checkWorkflows(dir).pipe(
					Effect.catchTag("CheckFailed", (e: CheckFailed) => Effect.succeed(e.reason)),
				),
			);
			assert.include(reason, "bad.js");
			assert.include(reason, "export-default");
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails on a missing-meta script", async () => {
		const dir = makeRepo({"nometa.js": `phase("Run");\nawait agent("x", {});`});
		try {
			const exit = await Effect.runPromiseExit(checkWorkflows(dir));
			assert.isTrue(Exit.isFailure(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails closed on an unparseable / garbage script (no resolvable contract)", async () => {
		const dir = makeRepo({"garbage.js": `}{ <<< not valid (( export ?? meta`});
		try {
			const exit = await Effect.runPromiseExit(checkWorkflows(dir));
			assert.isTrue(Exit.isFailure(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("passes clean on an empty set (no .claude/workflows dir)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "workflow-contract-empty-"));
		try {
			const exit = await Effect.runPromiseExit(checkWorkflows(dir));
			assert.isTrue(Exit.isSuccess(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);
});
