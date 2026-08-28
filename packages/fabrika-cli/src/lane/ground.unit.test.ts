/** The ground guard: a drifted cwd refuses on its own code, a repo with no such lane still boots. */
import {Effect, Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {LANE_ABSENT, LANE_UNREADABLE, NOT_A_REPO} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {deriveRepoRoot, onGround} from "./ground.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_LANES_ROOT} from "./store.ts";

const REPO = "/work/phoenix";
const DRIFTED = "/work/phoenix/scratchpad";
const REF = {root: DEFAULT_LANES_ROOT, lane: "42"};

/** `lane status` behind the guard, exactly as the adapter composes it. */
const status = (fs: ReturnType<typeof fakeFs>, cwd: string) =>
	Effect.runPromise(
		Effect.provide(
			onGround("status", [REF.root], cwd, () => runStatus(REF)),
			fs.layer,
		),
	);

describe("the ground under a lane verb's root", () => {
	it("proves a lane absent as before when the cwd IS a repo — a genuine boot is unaffected", async () => {
		const out = await status(fakeFs({files: {}, directories: [`${REPO}/.git`]}), REPO);

		expect(out.code).toBe(LANE_ABSENT);
		expect(out.stderr.join("\n")).toContain("copy a workflow template");
	});

	it("refuses a cwd holding neither marker on its own code, never the lane's absence", async () => {
		const out = await status(fakeFs({files: {}}), DRIFTED);

		expect(out.code).toBe(NOT_A_REPO);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(`${DRIFTED} is not a repo`);
		expect(out.stderr.join("\n")).toContain('NOT "no lane here"');
	});

	it("takes `.fabrika` alone as a repo — a checkout with lanes and no git dir of its own", async () => {
		const fs = fakeFs({
			files: {[`${DEFAULT_LANES_ROOT}/42/workflow.json`]: coderTemplateText()},
			directories: [`${REPO}/.fabrika`],
		});
		const out = await status(fs, REPO);

		expect(out.code).toBe(0);
	});

	it("owes no probe on an absolute root — nothing resolves against the cwd to drift", async () => {
		const fs = fakeFs({files: {}});
		const out = await Effect.runPromise(
			Effect.provide(
				onGround("status", ["/elsewhere/.fabrika/lanes"], DRIFTED, () => runStatus(REF)),
				fs.layer,
			),
		);

		expect(out.code).toBe(LANE_ABSENT);
	});

	it("keeps an unprobeable marker UNKNOWN rather than reading it as a repo or as drift", async () => {
		const fs = fakeFs({files: {}, unprobeable: [`${REPO}/.fabrika`]});
		const out = await status(fs, REPO);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
	});
});

describe("deriveRepoRoot — the default root resolves off the owning repository (#5815)", () => {
	const PRIMARY = "/primary";
	const WORKTREE = "/wt";
	/** A primary checkout plus a linked worktree whose `.git` file and `commondir` point home. */
	const repoFs = () =>
		fakeFs({
			directories: [`${PRIMARY}/.git`],
			dirs: {
				[`${PRIMARY}`]: [".git", ".fabrika"],
				[`${PRIMARY}/.git/worktrees/wt`]: [],
			},
			files: {
				[`${WORKTREE}/.git`]: "gitdir: /primary/.git/worktrees/wt",
				[`${PRIMARY}/.git/worktrees/wt/commondir`]: "../..",
				[`${PRIMARY}/${DEFAULT_LANES_ROOT}/42/workflow.json`]: coderTemplateText(),
			},
		});

	it("a worktree cwd and the primary cwd derive the same repository root", async () => {
		const fs = repoFs();
		const fromWorktree = await Effect.runPromise(
			Effect.provide(deriveRepoRoot(`${WORKTREE}/packages/app`), fs.layer),
		);
		const fromPrimary = await Effect.runPromise(
			Effect.provide(deriveRepoRoot(`${PRIMARY}/packages/cli`), fs.layer),
		);
		expect(fromWorktree).toEqual({_tag: "Derived", repoRoot: PRIMARY});
		expect(fromPrimary).toEqual(fromWorktree);
	});

	it("loads the primary ledger's same lane through status from either checkout cwd", async () => {
		const fs = repoFs();
		const statusFrom = (cwd: string) =>
			Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const path = yield* Path.Path;
						const ground = yield* deriveRepoRoot(cwd);
						if (ground._tag !== "Derived") return ground;
						return yield* runStatus({
							root: path.join(ground.repoRoot, DEFAULT_LANES_ROOT),
							lane: "42",
						});
					}),
					fs.layer,
				),
			);

		const fromPrimary = await statusFrom(`${PRIMARY}/packages/cli`);
		const fromWorktree = await statusFrom(`${WORKTREE}/packages/app`);

		expect(fromPrimary).toMatchObject({code: 0});
		expect(fromWorktree).toEqual(fromPrimary);
		expect("stdout" in fromWorktree && JSON.parse(fromWorktree.stdout)).toMatchObject({
			stateValue: {pipeline: {issue: "queued"}},
		});
	});

	it("a cwd with no .git ancestor is NotARepo — never a cwd-relative fallback", async () => {
		const fs = fakeFs({directories: ["/scratch/sub"]});
		const out = await Effect.runPromise(
			Effect.provide(deriveRepoRoot("/scratch/sub/deep"), fs.layer),
		);
		expect(out).toEqual({_tag: "NotARepo", cwd: "/scratch/sub/deep"});
	});

	it("a .git entry that names no readable repository is Unestablished — UNKNOWN, never absent", async () => {
		const fs = fakeFs({
			files: {["/wt/.git"]: "gitdir: /primary/.git/worktrees/gone"},
		});
		const out = await Effect.runPromise(Effect.provide(deriveRepoRoot("/wt"), fs.layer));
		expect(out._tag).toBe("Unestablished");
	});
});
