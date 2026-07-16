import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {CONTROL_PLANE_RE} from "../control-plane-paths/control-plane-re.ts";
import {type CheckFailed, CODEOWNERS_PATH, checkCodeownersCp, FORMATS_PATH} from "./gate.ts";

// The gate derives paths from the single-source const (#2761); a fixture formats doc must
// carry a matching CONTROL_PLANE_RE= line or the gate's const↔formats drift check fires.
const LIVE_RE = CONTROL_PLANE_RE;

const FULL_CODEOWNERS = [
	"/.claude/ @usirin",
	"/.github/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/ship-it/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-code/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-doc/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-skill/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-design/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-plan/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/triage/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/write-code/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/plan-epic/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/release/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/review-trivial/ @usirin",
	"/claude-plugins/kampus-pipeline/skills/**/*.sh @usirin",
	"/claude-plugins/kampus-pipeline/agents/ @usirin",
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

	it("fails closed when the formats-doc CONTROL_PLANE_RE has drifted from the single-source const", async () => {
		// The formats line carries a stale (shorter) boundary — the exact origin/main-read copy
		// that must never diverge from the const the gate derives from (#2761/#981).
		const drifted = "^(\\.claude|\\.github)/|^packages/pipeline-cli/";
		const dir = makeRepo({formats: `CONTROL_PLANE_RE='${drifted}'`, codeowners: FULL_CODEOWNERS});
		try {
			assert.include(await reasonOf(dir), "has drifted from the pipeline-cli single-source const");
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
