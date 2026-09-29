/**
 * `review scope` and `ship scope` over one file list, compared row for row.
 *
 * The two verbs live in different groups, read the changed files off different seams (git for
 * review, the pulls API for ship) and print different surrounding fields, so nothing but a test that
 * runs *both* catches them drifting. While only the ship side derived `ui`, a reviewer on a rendered
 * diff was told `review-code` was the whole bar, PASSed, and `ship gate` then refused a `review-ui`
 * namespace nobody had routed — one wasted ship dispatch and a park per PR.
 *
 * Both read the class config at the PR's head and merge base — review out of git, ship off the
 * platform — so each side is handed the same config at the same two commits here, and neither reads
 * the tree the test stands up.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	configAtCommit,
	configOnPlatform,
	fakeSeams,
	type HttpReply,
	mergeBaseOnPlatform,
	type Scripted,
	unconfigured,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	branchRules,
	CODEOWNERS,
	ENV,
	LINKED_WORKTREE,
	repositoryServed,
	files as shipFiles,
	pull as shipPull,
} from "../ship/fixtures.test-support.ts";
import {runScope as runShipScope} from "../ship/scope-verb.ts";
import {BASE, binding, PATHS_AT, paths, pull as reviewPull} from "./fixtures.test-support.ts";
import {runScope as runReviewScope} from "./scope-verb.ts";

/** One mixed diff: a worker source file, a doc, and a rendered surface beside its own test. */
const CHANGED = [
	"apps/site/worker/cart.ts",
	"README.md",
	"apps/site/src/components/layout/Topbar.tsx",
	"apps/site/src/components/layout/Topbar.test.tsx",
] as const;

const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const SHIP_FILES = /^GET \S+\/repos\/o\/r\/pulls\/4321\/files\?/;
const OWNERS = /contents\/\.github\/CODEOWNERS/;
const RULES = /^GET \S+\/repos\/o\/r\/rules\/branches\/main/;
const REPO = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;

const namespaceRows = (stdout: string): ReadonlyArray<string> =>
	stdout
		.split("\n")
		.filter((line) => line.startsWith("namespace\t"))
		.map((line) => line.slice("namespace\t".length));

/** The `.fabrika.jsonc` both commits carry. */
type Config = string;

const configOf = (uiSurfaces: ReadonlyArray<unknown>): Config => JSON.stringify({uiSurfaces});

const twoApps: Config = configOf([
	{name: "web", prefix: "apps/site/src/", mount: "/", command: "pnpm dev --port {{port}}"},
	{
		name: "desk-chat",
		prefix: "apps/desk/src/",
		mount: "/desk/chat",
		basePath: "/",
		command: "pnpm proof:chat --port {{port}}",
	},
]);

const reviewScopeOver =
	(config: Config) =>
	(...changed: ReadonlyArray<string>) =>
		Effect.runPromise(
			Effect.provide(
				runReviewScope({
					pr: 4321,
					sha: null,
					repo: null,
					json: false,
					cwd: "/repo",
					env: {CLAUDE_PIPELINE_REPO: "o/r"},
				}),
				Layer.merge(
					fakeSeams([
						...configAtCommit(config),
						[PULL, served(reviewPull({changedFiles: changed.length}))],
						...binding(),
						[PATHS_AT(), paths(...changed)],
					]).layer,
					unconfigured,
				),
			),
		);

const reviewScope = reviewScopeOver(twoApps);

/**
 * `caller: "shipper"` with the worktree read scripted, because that is the run whose answer the
 * review side has to agree with — a `relay` seat would compare against a read no shipper performs.
 */
const shipScopeOver =
	(config: Config) =>
	(...changed: ReadonlyArray<string>) =>
		Effect.runPromise(
			Effect.provide(
				runShipScope({
					pr: 4321,
					repo: null,
					json: false,
					env: ENV,
					caller: "shipper",
				}),
				Layer.merge(
					fakeSeams([
						[PULL, served(shipPull({changedFiles: changed.length}))],
						[SHIP_FILES, served(shipFiles(...changed))],
						[OWNERS, {status: 200, body: CODEOWNERS}],
						[RULES, served(branchRules("pull_request"))],
						[REPO, repositoryServed()],
						mergeBaseOnPlatform(BASE),
						...configOnPlatform(config),
						LINKED_WORKTREE,
					] as ReadonlyArray<Scripted>).layer,
					unconfigured,
				),
			),
		);

const shipScope = shipScopeOver(twoApps);

/** A root-level app: one row naming two directories and one root file as its source roots. */
const rootLevelApp: Config = configOf([
	{
		name: "web",
		prefix: ["app/", "components/", "tailwind.config.ts"],
		mount: "/",
		command: "pnpm dev --port {{port}}",
	},
]);

describe("review scope and ship scope over one file list", () => {
	it("derive the same required-namespace set from a mixed code + ui diff", async () => {
		const review = await reviewScope(...CHANGED);
		const ship = await shipScope(...CHANGED);

		expect(review.code).toBe(0);
		expect(ship.code).toBe(0);
		expect(namespaceRows(review.stdout)).toEqual(["review-code", "review-doc", "review-ui"]);
		expect(namespaceRows(review.stdout)).toEqual(namespaceRows(ship.stdout));
	});

	it("names `review-ui` routed on the review side — derived there, emitted only by `review-ui`", async () => {
		const review = await reviewScope(...CHANGED);

		expect(review.stdout).toContain("class\tui\t1");
		expect(review.stdout).toContain("routed\treview-ui");
	});

	it.each([
		["the first listed directory", ["app/page.tsx"]],
		["the second listed directory", ["components/Nav.tsx"]],
		["the listed root file alone", ["tailwind.config.ts"]],
	])("both raise the ui class off %s of a list-shaped prefix", async (_label, changed) => {
		const review = await reviewScopeOver(rootLevelApp)(...changed);
		const ship = await shipScopeOver(rootLevelApp)(...changed);

		expect(review.stdout).toContain("class\tui\t1");
		expect(namespaceRows(review.stdout)).toEqual(["review-code", "review-ui"]);
		expect(namespaceRows(ship.stdout)).toEqual(namespaceRows(review.stdout));
	});

	it("both leave a file that only shares a listed root file's leading characters outside ui", async () => {
		const review = await reviewScopeOver(rootLevelApp)("tailwind.config.ts.bak");
		const ship = await shipScopeOver(rootLevelApp)("tailwind.config.ts.bak");

		expect(review.stdout).not.toContain("class\tui");
		expect(namespaceRows(review.stdout)).toEqual(["review-code"]);
		expect(namespaceRows(ship.stdout)).toEqual(["review-code"]);
	});

	it("routes nothing when the diff raises no ui class", async () => {
		const review = await reviewScope("apps/site/worker/cart.ts");

		expect(review.stdout).not.toContain("routed\t");
		expect(namespaceRows(review.stdout)).toEqual(["review-code"]);
	});
});
