import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {type CheckFailed, CODEOWNERS_PATH, checkCodeownersCp, FORMATS_PATH} from "./gate.ts";

const LIVE_RE =
	"^(\\.claude|\\.github)/|^claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-plan)/|^claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\\.md$|^claude-plugins/kampus-pipeline/hooks(/|\\.json$)|^packages/ci-required/|^packages/pipeline-cli/";

const FULL_CODEOWNERS = [
	"/.claude/ @usirin",
	"/.github/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/ship-it/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-code/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-doc/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-skill/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-plan/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md @usirin",
	"/claude-plugins/kampus-pipeline/hooks/ @usirin",
	"/claude-plugins/kampus-pipeline/hooks.json @usirin",
	"/packages/ci-required/ @usirin",
	"/packages/pipeline-cli/ @usirin",
].join("\n");

/** A throwaway repo carrying just the two source files the gate reads. */
const makeRepo = (opts: {formats?: string; codeowners?: string}): string => {
	const dir = mkdtempSync(join(tmpdir(), "codeowners-cp-"));
	const write = (rel: string, content: string) => {
		const p = join(dir, rel);
		mkdirSync(join(p, ".."), {recursive: true});
		writeFileSync(p, content, "utf8");
	};
	if (opts.formats !== undefined) write(FORMATS_PATH, opts.formats);
	if (opts.codeowners !== undefined) write(CODEOWNERS_PATH, opts.codeowners);
	return dir;
};

const reasonOf = (dir: string): Promise<string> =>
	Effect.runPromise(
		checkCodeownersCp(dir).pipe(
			Effect.catchTag("CheckFailed", (e: CheckFailed) => Effect.succeed(e.reason)),
			Effect.map((r) => (typeof r === "string" ? r : "")),
		),
	);

describe("checkCodeownersCp", () => {
	it("succeeds when CODEOWNERS covers every §CP path", async () => {
		const dir = makeRepo({formats: `CONTROL_PLANE_RE='${LIVE_RE}'`, codeowners: FULL_CODEOWNERS});
		try {
			const exit = await Effect.runPromiseExit(checkCodeownersCp(dir));
			assert.isTrue(Exit.isSuccess(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails CheckFailed naming the unowned §CP path (the drift)", async () => {
		const stale = FULL_CODEOWNERS.split("\n")
			.filter((l) => !l.includes("pipeline-cli"))
			.join("\n");
		const dir = makeRepo({formats: `CONTROL_PLANE_RE='${LIVE_RE}'`, codeowners: stale});
		try {
			const exit = await Effect.runPromiseExit(checkCodeownersCp(dir));
			assert.isTrue(Exit.isFailure(exit));
			assert.include(await reasonOf(dir), "packages/pipeline-cli/");
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails closed when CONTROL_PLANE_RE cannot be parsed", async () => {
		const dir = makeRepo({formats: "no regex here", codeowners: FULL_CODEOWNERS});
		try {
			assert.include(await reasonOf(dir), "could not parse CONTROL_PLANE_RE");
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails closed when the regex resolves zero §CP paths", async () => {
		const dir = makeRepo({formats: "CONTROL_PLANE_RE=''", codeowners: FULL_CODEOWNERS});
		try {
			assert.include(await reasonOf(dir), "ZERO §CP paths");
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails closed when CODEOWNERS has zero owned entries", async () => {
		const dir = makeRepo({
			formats: `CONTROL_PLANE_RE='${LIVE_RE}'`,
			codeowners: "# only comments\n",
		});
		try {
			assert.include(await reasonOf(dir), "ZERO owned entries");
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);

	it("fails (IoError) when a source file is missing — refusing rather than passing", async () => {
		const dir = makeRepo({codeowners: FULL_CODEOWNERS}); // no formats file
		try {
			const exit = await Effect.runPromiseExit(checkCodeownersCp(dir));
			assert.isTrue(Exit.isFailure(exit));
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}, 30_000);
});
