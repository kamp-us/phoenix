/**
 * `review scope` and `ship scope` over one file list, compared row for row.
 *
 * The two verbs live in different groups, read the changed files off different seams (git for
 * review, the pulls API for ship) and print different surrounding fields, so nothing but a test that
 * runs *both* catches them drifting. While only the ship side derived `ui`, a reviewer on a rendered
 * diff was told `review-code` was the whole bar, PASSed, and `ship gate` then refused a `review-ui`
 * namespace nobody had routed — one wasted ship dispatch and a park per PR (#6664).
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted, unconfigured} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	branchRules,
	CODEOWNERS,
	ENV,
	repositoryServed,
	files as shipFiles,
	pull as shipPull,
} from "../ship/fixtures.test-support.ts";
import {runScope as runShipScope} from "../ship/scope-verb.ts";
import {binding, PATHS_AT, paths, pull as reviewPull} from "./fixtures.test-support.ts";
import {runScope as runReviewScope} from "./scope-verb.ts";

/** One mixed diff: a worker source file, a doc, and a rendered surface beside its own test. */
const CHANGED = [
	"apps/web/worker/cart.ts",
	"README.md",
	"apps/web/src/components/layout/Topbar.tsx",
	"apps/web/src/components/layout/Topbar.test.tsx",
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

const reviewScope = (...changed: ReadonlyArray<string>) =>
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
					[PULL, served(reviewPull({changedFiles: changed.length}))],
					...binding(),
					[PATHS_AT(), paths(...changed)],
				]).layer,
				unconfigured,
			),
		),
	);

const shipScope = (...changed: ReadonlyArray<string>) =>
	Effect.runPromise(
		Effect.provide(
			runShipScope({pr: 4321, repo: null, json: false, cwd: "/repo", env: ENV}),
			Layer.merge(
				fakeSeams([
					[PULL, served(shipPull({changedFiles: changed.length}))],
					[SHIP_FILES, served(shipFiles(...changed))],
					[OWNERS, {status: 200, body: CODEOWNERS}],
					[RULES, served(branchRules("pull_request"))],
					[REPO, repositoryServed()],
				] as ReadonlyArray<Scripted>).layer,
				unconfigured,
			),
		),
	);

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

	it("routes nothing when the diff raises no ui class", async () => {
		const review = await reviewScope("apps/web/worker/cart.ts");

		expect(review.stdout).not.toContain("routed\t");
		expect(namespaceRows(review.stdout)).toEqual(["review-code"]);
	});
});
