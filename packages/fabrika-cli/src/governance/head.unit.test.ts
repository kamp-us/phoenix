import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, okOut} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, STALE_HEAD} from "./codes.ts";
import {binding, HEAD, OLD_HEAD} from "./fixtures.test-support.ts";
import {bindGovernanceHead, withBindingNoun} from "./head.ts";

const PULL_RECORD = {
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
	authorLogin: "usirin",
	assignees: [],
	updatedAt: "2026-08-08T00:00:00Z",
};

const TAIL = "the file list cannot be bound to a commit, so the derivation is UNKNOWN.";

const bind = (
	script: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>,
	asked: string | null = null,
) =>
	Effect.runPromise(
		Effect.provide(
			bindGovernanceHead("governance scope", TAIL, "o/r", 4321, PULL_RECORD, asked),
			fakeShell(script).layer,
		),
	);

describe("withBindingNoun", () => {
	it("swaps the imported tail for this verb's", () => {
		expect(
			withBindingNoun(
				"governance scope: no remote — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.",
				TAIL,
			),
		).toBe(`governance scope: no remote — ${TAIL}`);
	});

	it("passes through a message that does not carry the imported tail", () => {
		expect(withBindingNoun("governance scope: something else.", TAIL)).toBe(
			"governance scope: something else.",
		);
	});
});

describe("bindGovernanceHead", () => {
	it("binds through the imported `bindHead` and reports both ends of the range", async () => {
		const bound = await bind(binding());
		expect(bound._tag).toBe("Bound");
	});

	it("re-phrases the 11 refusal in this verb's noun, so a reader is not left to guess", async () => {
		const bound = await bind([
			[/^git remote -v$/, okOut("origin\tgit@github.com:someone/else.git (fetch)\n")],
		]);
		expect(bound._tag).toBe("Refused");
		if (bound._tag !== "Refused") return;
		expect(bound.outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(bound.outcome.stderr.at(-1)).toBe(
			`governance scope: no git remote in this checkout serves o/r — ${TAIL}`,
		);
	});

	it("leaves the 12 refusal exactly as the imported binding phrases it", async () => {
		const bound = await bind(binding(), OLD_HEAD);
		expect(bound._tag).toBe("Refused");
		if (bound._tag !== "Refused") return;
		expect(bound.outcome.code).toBe(STALE_HEAD);
		expect(bound.outcome.stderr.at(-1)).toContain("re-scope at");
	});
});
