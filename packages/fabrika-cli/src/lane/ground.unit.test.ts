/**
 * The ground guard: a drifted cwd refuses on its own code, a lanes root inside a linked worktree
 * refuses on another, and a repo with no such lane still boots.
 */
import {Effect, Path} from "effect";
import {describe, expect, it} from "vitest";
import {laneConcurrencyCapKey} from "../config/keys/lane-concurrency-cap.ts";
import {readKey} from "../config/read-key.ts";
import {fakeFs} from "../fakes.test-support.ts";
import {LANE_ABSENT, LANE_UNREADABLE, NOT_A_REPO, ROOT_NOT_OWNED} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {configRootOrRefuse, deriveRepoRoot, onGround} from "./ground.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_LANES_ROOT} from "./store.ts";

const REPO = "/work/repo";
const DRIFTED = "/work/repo/scratchpad";
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

	it("grounds an absolute root under no working tree at all — a relocated root duplicates nothing", async () => {
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

describe("deriveRepoRoot — the default root resolves off the owning repository", () => {
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
		expect(fromWorktree).toEqual({_tag: "Derived", repoRoot: PRIMARY, workingTree: WORKTREE});
		expect(fromPrimary).toEqual({_tag: "Derived", repoRoot: PRIMARY, workingTree: PRIMARY});
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

	it("carries the working tree the .git entry sits in beside the repository that owns it", async () => {
		const fs = repoFs();
		const out = await Effect.runPromise(
			Effect.provide(deriveRepoRoot(`${WORKTREE}/pkg`), fs.layer),
		);

		expect(out).toEqual({_tag: "Derived", repoRoot: PRIMARY, workingTree: WORKTREE});
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
			files: {"/wt/.git": "gitdir: /primary/.git/worktrees/gone"},
		});
		const out = await Effect.runPromise(Effect.provide(deriveRepoRoot("/wt"), fs.layer));
		expect(out._tag).toBe("Unestablished");
	});
});

/**
 * The incident on lane 8810: a lanes root under a linked worktree is a second copy of the owning
 * repository's ledger, and folding it answers from a frozen moment rather than failing.
 */
describe("a lanes root that stands in a working tree which does not own it", () => {
	const PRIMARY = "/primary";
	const WORKTREE = "/wt";
	const WORKTREE_CWD = `${WORKTREE}/packages/fabrika-cli`;
	const PRIMARY_LANES = `${PRIMARY}/${DEFAULT_LANES_ROOT}`;
	const WORKTREE_LANES = `${WORKTREE}/${DEFAULT_LANES_ROOT}`;

	/** The live ledger at the primary checkout, and a copy of the same lane under the worktree. */
	const bothCopies = () =>
		fakeFs({
			directories: [`${PRIMARY}/.git`],
			dirs: {
				[PRIMARY]: [".git", ".fabrika"],
				[`${PRIMARY}/.git/worktrees/wt`]: [],
			},
			files: {
				[`${WORKTREE}/.git`]: "gitdir: /primary/.git/worktrees/wt",
				[`${PRIMARY}/.git/worktrees/wt/commondir`]: "../..",
				[`${PRIMARY_LANES}/42/workflow.json`]: coderTemplateText(),
				[`${WORKTREE_LANES}/42/workflow.json`]: coderTemplateText(),
			},
		});

	const statusAt = (fs: ReturnType<typeof fakeFs>, root: string, cwd: string) =>
		Effect.runPromise(
			Effect.provide(
				onGround("status", [root], cwd, () => runStatus({root, lane: "42"})),
				fs.layer,
			),
		);

	it("refuses the worktree's own copy on its own code instead of folding it", async () => {
		const out = await statusAt(bothCopies(), WORKTREE_LANES, WORKTREE_CWD);

		expect(out.code).toBe(ROOT_NOT_OWNED);
		expect(out.stdout).toBe("");
	});

	it("names both the root it was handed and the repository that owns it", async () => {
		const out = await statusAt(bothCopies(), WORKTREE_LANES, WORKTREE_CWD);
		const said = out.stderr.join("\n");

		expect(said).toContain(WORKTREE_LANES);
		expect(said).toContain(WORKTREE);
		expect(said).toContain(PRIMARY);
		expect(said).toContain('NOT "no lane here"');
	});

	it("refuses a relative root the same way — the worktree cwd is a repo, and still not the owner", async () => {
		const out = await statusAt(bothCopies(), DEFAULT_LANES_ROOT, WORKTREE);

		expect(out.code).toBe(ROOT_NOT_OWNED);
	});

	it("passes an absolute root inside the owning primary checkout, read from the worktree", async () => {
		const out = await statusAt(bothCopies(), PRIMARY_LANES, WORKTREE_CWD);

		expect(out.code).toBe(0);
	});

	it("passes a relocated absolute root that lies outside every working tree", async () => {
		const fs = fakeFs({
			directories: [`${PRIMARY}/.git`],
			files: {"/elsewhere/lanes/42/workflow.json": coderTemplateText()},
		});
		const out = await statusAt(fs, "/elsewhere/lanes", WORKTREE_CWD);

		expect(out.code).toBe(0);
	});
});

/**
 * The straddle: the lanes root derived off the owning repository while the cap was read off the cwd,
 * so a worktree-spawned driver was capped by a file governing no seat it had counted.
 */
describe("the config root a seat-counting verb reads its cap from", () => {
	const PRIMARY = "/primary";
	const WORKTREE = "/wt";
	const WORKTREE_CWD = `${WORKTREE}/packages/fabrika-cli`;

	/** Both checkouts carry a tracked `.fabrika.jsonc`, and they declare different caps. */
	const bothConfigs = () =>
		fakeFs({
			directories: [`${PRIMARY}/.git`],
			dirs: {
				[PRIMARY]: [".git", ".fabrika"],
				[`${PRIMARY}/.git/worktrees/wt`]: [],
			},
			files: {
				[`${WORKTREE}/.git`]: "gitdir: /primary/.git/worktrees/wt",
				[`${PRIMARY}/.git/worktrees/wt/commondir`]: "../..",
				[`${PRIMARY}/.fabrika.jsonc`]: '{"laneConcurrencyCap": 10}',
				[`${WORKTREE}/.fabrika.jsonc`]: '{"laneConcurrencyCap": 2}',
			},
		});

	const capFrom = (fs: ReturnType<typeof fakeFs>, cwd: string) =>
		Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const root = yield* configRootOrRefuse("fabrika lane open", cwd);
					return typeof root === "string" ? yield* readKey(root, laneConcurrencyCapKey) : root;
				}),
				fs.layer,
			),
		);

	it("resolves a worktree cwd to the primary checkout's file, not the worktree's own", async () => {
		const fs = bothConfigs();
		const root = await Effect.runPromise(
			Effect.provide(configRootOrRefuse("fabrika lane open", WORKTREE), fs.layer),
		);

		expect(root).toBe(PRIMARY);
		expect(await capFrom(fs, WORKTREE)).toMatchObject({_tag: "Value", value: 10});
	});

	it("resolves the same way from a subdirectory of the worktree", async () => {
		expect(await capFrom(bothConfigs(), WORKTREE_CWD)).toMatchObject({_tag: "Value", value: 10});
	});

	it("reads that same value from the primary checkout — the unchanged path", async () => {
		expect(await capFrom(bothConfigs(), PRIMARY)).toMatchObject({_tag: "Value", value: 10});
	});

	it("keeps reading at a cwd that belongs to no repository — there is no owner to prefer", async () => {
		const fs = fakeFs({files: {"/loose/.fabrika.jsonc": '{"laneConcurrencyCap": 3}'}});

		expect(await capFrom(fs, "/loose")).toMatchObject({_tag: "Value", value: 3});
	});

	it("refuses a cwd whose repository cannot be read rather than falling back to it", async () => {
		const fs = fakeFs({files: {}, unprobeable: [`${PRIMARY}/.git`]});

		expect(await capFrom(fs, PRIMARY)).toMatchObject({code: LANE_UNREADABLE});
	});
});
