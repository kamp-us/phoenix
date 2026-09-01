/**
 * Where `recipe unpark` looks for the lane its caller named (#7380).
 *
 * The verb relays `lane status`, and those verbs derive their root off the owning repository, so a
 * bare cwd-relative default here made one lane key name two directories: from a worktree the lane
 * verbs folded the primary checkout's ledger while this one proved the same lane absent at 7 — an
 * exit `operate` step 4 does not route, so a self-healing park cost a human instead.
 */
import {Effect, Layer, Option} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams} from "../fakes.test-support.ts";
import {NOT_A_REPO} from "../lane/codes.ts";
import {resolveRootOrRefuse} from "../lane/ground.ts";
import {DEFAULT_LANES_ROOT} from "../lane/store.ts";
import {ENV} from "../ship/fixtures.test-support.ts";
import {PARK_NOVEL, TARGET_ABSENT} from "./codes.ts";
import {LANE, laneTemplate, PARKED_BLOCKED} from "./fixtures.test-support.ts";
import {runUnpark} from "./unpark-verb.ts";

const VERB = "fabrika recipe unpark";
const PRIMARY = "/primary";
const WORKTREE = "/wt";
const WORKTREE_CWD = `${WORKTREE}/packages/fabrika-cli`;

/** A primary checkout carrying the parked lane, plus a linked worktree whose `.git` points home. */
const repoFs = () =>
	fakeFs({
		directories: [`${PRIMARY}/.git`],
		dirs: {
			[PRIMARY]: [".git", ".fabrika"],
			[`${PRIMARY}/.git/worktrees/wt`]: [],
		},
		files: {
			[`${WORKTREE}/.git`]: "gitdir: /primary/.git/worktrees/wt",
			[`${PRIMARY}/.git/worktrees/wt/commondir`]: "../..",
			[`${PRIMARY}/${DEFAULT_LANES_ROOT}/${LANE}/workflow.json`]: laneTemplate(),
			[`${PRIMARY}/${DEFAULT_LANES_ROOT}/${LANE}/events.jsonl`]: PARKED_BLOCKED,
		},
	});

/** The adapter's own composition: resolve the root off the cwd, then hand the verb what it resolved. */
const unparkFrom = (fs: ReturnType<typeof fakeFs>, cwd: string, root: Option.Option<string>) =>
	Effect.runPromise(
		Effect.provide(
			Effect.gen(function* () {
				const resolved = yield* resolveRootOrRefuse(VERB, root, DEFAULT_LANES_ROOT, cwd);
				return typeof resolved === "string"
					? yield* runUnpark({root: resolved, lane: LANE, task: null, repo: null, cwd, env: ENV})
					: resolved;
			}),
			Layer.merge(fs.layer, fakeSeams([]).layer),
		),
	);

describe("the lanes root recipe unpark resolves (#7380)", () => {
	it("reaches the primary checkout's lane from a worktree cwd instead of proving it absent", async () => {
		const out = await unparkFrom(repoFs(), WORKTREE_CWD, Option.none());

		expect(out.code).toBe(PARK_NOVEL);
		expect(out.code).not.toBe(TARGET_ABSENT);
	});

	it("resolves the same directory from the primary cwd as from the worktree", async () => {
		const fromPrimary = await unparkFrom(repoFs(), `${PRIMARY}/packages/cli`, Option.none());
		const fromWorktree = await unparkFrom(repoFs(), WORKTREE_CWD, Option.none());

		expect(fromWorktree).toEqual(fromPrimary);
	});

	it("lets an explicit --root win over the derived one", async () => {
		const out = await unparkFrom(
			repoFs(),
			WORKTREE_CWD,
			Option.some(`${PRIMARY}/${DEFAULT_LANES_ROOT}`),
		);

		expect(out.code).toBe(PARK_NOVEL);
	});

	// The control: the bare relative leaf this verb used to default to, from the same cwd and the
	// same tree the derived root reaches the lane in.
	it("proves the lane absent under the cwd-relative leaf the defect defaulted to", async () => {
		const out = await unparkFrom(repoFs(), WORKTREE_CWD, Option.some(DEFAULT_LANES_ROOT));

		expect(out.code).toBe(TARGET_ABSENT);
	});

	it("refuses a cwd under no repository rather than resolving a relative path", async () => {
		const out = await unparkFrom(
			fakeFs({directories: ["/scratch"]}),
			"/scratch/deep",
			Option.none(),
		);

		expect(out.code).toBe(NOT_A_REPO);
		expect(out.stderr.join("\n")).toContain(`${VERB}: /scratch/deep is not a repo`);
		expect(out.stderr.join("\n")).not.toContain("fabrika lane fabrika");
	});
});
