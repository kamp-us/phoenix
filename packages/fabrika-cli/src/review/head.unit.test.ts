/**
 * The binding's own tests, all of them run against a **moved base branch** — `origin/main` ahead of
 * the commit this branch left it at.
 *
 * That is the only arrangement in which the two values are distinguishable, and for a long time
 * nothing here arranged it: the binding resolved `origin/<baseRef>` and every caller downstream read
 * that one value as "the base", so a verb printing the branch tip and a verb printing the branch
 * point were indistinguishable from any test (#5770).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {PullRecord} from "../io/pulls.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {BASE, BASE_TIP, HEAD, OLD_HEAD} from "./fixtures.test-support.ts";
import {bindHead, boundLine} from "./head.ts";

const PULL: PullRecord = {
	number: 4321,
	state: "open",
	headSha: HEAD,
	body: "",
	htmlUrl: "https://github.com/o/r/pull/4321",
	changedFiles: 2,
	comments: 0,
	draft: false,
	merged: false,
	baseRef: "main",
	autoMerge: false,
	authorLogin: "kampus-bot",
	assignees: [],
	updatedAt: "2026-08-18T00:00:00Z",
};

/** `origin/main` resolves AHEAD of the branch point, which is the normal state of a busy main. */
const MOVED_MAIN: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[
		/^git remote -v$/,
		okOut("origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\n"),
	],
	[/^git fetch --quiet origin pull\/4321\/head$/, okOut("")],
	[new RegExp(`^git rev-parse --verify --quiet ${HEAD}\\^\\{commit\\}$`), okOut(`${HEAD}\n`)],
	[/^git remote$/, okOut("origin\n")],
	[/^git fetch --quiet origin main$/, okOut("")],
	[/^git rev-parse --verify --quiet origin\/main\^\{commit\}$/, okOut(`${BASE_TIP}\n`)],
	[new RegExp(`^git merge-base ${BASE_TIP} ${HEAD}$`), okOut(`${BASE}\n`)],
];

const bind = (script: ReadonlyArray<readonly [RegExp, ExecResult]> = MOVED_MAIN) => {
	const fake = fakeShell(script);
	return {
		fake,
		bound: Effect.runPromise(
			Effect.provide(bindHead("review scope", "o/r", 4321, PULL, null), fake.layer),
		),
	};
};

describe("bindHead under a moved base branch", () => {
	it("carries the branch tip and the merge base as two different commits", async () => {
		const bound = await bind().bound;
		expect(bound._tag).toBe("Bound");
		if (bound._tag !== "Bound") return;
		expect(bound.head.sha).toBe(HEAD);
		expect(bound.head.baseTip).toBe(BASE_TIP);
		expect(bound.head.mergeBase).toBe(BASE);
	});

	it("asks git for the merge base of the tip and the head, never assuming the tip is one", async () => {
		const {fake, bound} = bind();
		await bound;
		expect(fake.calls).toContain(`git merge-base ${BASE_TIP} ${HEAD}`);
	});

	/**
	 * The divergence criterion of #5770, stated as the report stated it: on the observed instance the
	 * printed base was a *later* main commit than the real branch point, so the failure this pins is a
	 * tip leaking into the line, not a stale local ref.
	 */
	it("prints the merge base on the bound line, never the tip that is ahead of it", async () => {
		const bound = await bind().bound;
		if (bound._tag !== "Bound") throw new Error("expected a binding");
		const line = boundLine("review scope", bound.head);
		expect(line).toContain(`(base ${BASE})`);
		expect(line).not.toContain(BASE_TIP);
	});

	it("refuses on 11 when git names no merge base — UNKNOWN, never the tip as a fallback", async () => {
		const bound = await bind([
			...MOVED_MAIN.filter((entry) => !entry[0].source.startsWith("^git merge-base")),
			[/^git merge-base /, errOut("fatal: refusing to work with unrelated histories")],
		]).bound;
		expect(bound._tag).toBe("Refused");
		if (bound._tag !== "Refused") return;
		expect(bound.outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(bound.outcome.stderr.at(-1)).toContain(
			`cannot resolve the merge base of main (${BASE_TIP})`,
		);
	});

	it("still refuses a --sha the PR has moved past, before it resolves any base", async () => {
		const fake = fakeShell(MOVED_MAIN);
		const bound = await Effect.runPromise(
			Effect.provide(bindHead("review scope", "o/r", 4321, PULL, OLD_HEAD), fake.layer),
		);
		expect(bound._tag).toBe("Refused");
		expect(fake.calls).toEqual([]);
	});
});
