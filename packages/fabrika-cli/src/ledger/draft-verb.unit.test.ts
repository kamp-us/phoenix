import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS} from "../build/fixtures.test-support.ts";
import {errOut, fakeFs, fakeShell} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	EMPTY_STDIN,
	EPIC_MOVED,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {runDraft} from "./draft-verb.ts";
import {CLAIMED, DIR, env, epic, planBlock, TOKEN} from "./fixtures.test-support.ts";
import {planPath, renderRunRecord, runJsonPath} from "./run.ts";

const EPIC_BODY = "An epic brief about the moderation queue.\n";
const DIGEST = bodyDigest(EPIC_BODY);

const GROUND: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[/^gh api repos\/o\/r\/issues\/4300$/, epic()],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
];

const RUN_JSON = renderRunRecord({
	epic: 4300,
	run: "4300-c1a4d6f8",
	mode: "fresh",
	cycleDoc: "present",
	bodyDigest: DIGEST,
});

const text = (value: string): Effect.Effect<StdinRead> =>
	Effect.succeed({_tag: "Text", text: value});

const run = (
	stdin: Effect.Effect<StdinRead>,
	options: {
		digest?: string;
		script?: ReadonlyArray<readonly [RegExp, ExecResult]>;
		files?: Readonly<Record<string, string | null>>;
	} = {},
) => {
	const shell = fakeShell(options.script ?? GROUND);
	const fs = fakeFs({files: options.files ?? {[runJsonPath(DIR)]: RUN_JSON}});
	return Effect.runPromise(
		Effect.provide(
			runDraft({
				number: 4300,
				bodyDigest: options.digest ?? DIGEST,
				token: TOKEN,
				repo: null,
				env,
				stdin,
			}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	).then((outcome) => ({outcome, written: fs.written}));
};

describe("runDraft", () => {
	it("stages the plan and reports what it validated", async () => {
		const block = planBlock();
		const {outcome, written} = await run(text(block));
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "staged",
			epic: 4300,
			document: "plan",
			sections: 10,
			stories: [1, 2],
		});
		expect(written.get(planPath(DIR))).toBe(block);
	});

	it("refuses a plan block off the section set", async () => {
		const {outcome} = await run(text(planBlock({drop: "Approach"})));
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stdout).toBe("");
	});

	it("refuses a plan declaring zero stories before it can reach the gate", async () => {
		const {outcome} = await run(text(planBlock({stories: "- a bullet story"})));
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.at(-1)).toContain("zero user stories");
	});

	/** An unread pipe is UNKNOWN and seats on `1`; a read-but-empty one is a proven `3`. */
	it("separates an empty pipe from an unread one", async () => {
		const {outcome: empty} = await run(text("   \n"));
		expect(empty.code).toBe(EMPTY_STDIN);
		const {outcome: unread} = await run(
			Effect.succeed({_tag: "Failed", reason: "EAGAIN"} as StdinRead),
		);
		expect(unread.code).toBe(1);
	});

	it("refuses a machine-local path, masked in the refusal", async () => {
		const {outcome} = await run(
			text(
				planBlock().replace("Something true about this section.", "see /Users/someone/notes.md"),
			),
		);
		expect(outcome.code).toBe(LEAKED_PATH);
		expect(outcome.stderr.join("\n")).toContain("/Users/<redacted>");
		expect(outcome.stderr.join("\n")).not.toContain("someone");
	});

	it("refuses a bare @ path reference on its own code", async () => {
		const {outcome} = await run(text("@some/path/plan.md"));
		expect(outcome.code).toBe(BARE_AT_PATH);
	});

	it("refuses a malformed --body-digest before any read", async () => {
		const {outcome} = await run(text(planBlock()), {digest: "nope"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'ledger draft: --body-digest must be 12 lowercase hex — got "nope".',
		);
	});

	/** The gap between deciding and writing is closed by re-deciding, not by trusting. */
	it("refuses when the epic body moved since open", async () => {
		const {outcome, written} = await run(text(planBlock()), {digest: "0123456789ab"});
		expect(outcome.code).toBe(EPIC_MOVED);
		expect(written.size).toBe(0);
	});

	/** A run.json that is absent is UNKNOWN, never assumed fresh. */
	it("refuses when the run directory holds no run.json", async () => {
		const {outcome} = await run(text(planBlock()), {files: {}});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses an unparseable run.json for the same reason", async () => {
		const {outcome} = await run(text(planBlock()), {files: {[runJsonPath(DIR)]: "{}"}});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses an unreadable tree root on 11 — the run directory is UNKNOWN", async () => {
		const {outcome} = await run(text(planBlock()), {
			script: [
				[/^gh api repos\/o\/r\/issues\/4300$/, epic()],
				[/^git rev-parse --path-format=absolute/, errOut("fatal: not a git repository")],
				...CLAIMED,
			],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger draft: cannot read the tree root: fatal: not a git repository — the ground is UNKNOWN.",
		);
	});

	it("refuses an issue that is not a type:epic", async () => {
		const {outcome} = await run(text(planBlock()), {
			script: [
				[/^gh api repos\/o\/r\/issues\/4300$/, epic({labels: [{name: "type:chore"}]})],
				[/^git rev-parse --path-format=absolute/, GIT_DIRS],
				...CLAIMED,
			],
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger draft: #4300 is not a type:epic — refusing to stage a plan for it.",
		);
	});

	it("re-staging replaces the previous document", async () => {
		const {written} = await run(text(planBlock()), {
			files: {[runJsonPath(DIR)]: RUN_JSON, [planPath(DIR)]: "an older plan\n"},
		});
		expect(written.get(planPath(DIR))).toBe(planBlock());
	});

	it("stages a plan whose sections say nothing — content is the skill's judgment", async () => {
		const {outcome} = await run(
			text(planBlock().replace(/Something true about this section\./g, "TBD")),
		);
		expect(outcome.code).toBe(0);
	});
});
