import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell} from "../fakes.test-support.ts";
import {type CiEvent, filesFor, resolveBasis} from "./changed-files.ts";

const event = (over: Partial<CiEvent>): CiEvent => ({
	eventName: undefined,
	baseRef: undefined,
	mergeGroupBaseSha: undefined,
	defaultBranch: "main",
	...over,
});

describe("resolveBasis", () => {
	it("diffs a pull request against its target branch", () => {
		expect(resolveBasis(event({eventName: "pull_request", baseRef: "main"}))).toEqual({
			_tag: "Range",
			base: "origin/main",
		});
	});

	// On the queue's batched ref `base_ref` is empty, so the batch's own base commit is the basis
	// (ADR 0132) — that is what yields exactly the files the batch adds vs main.
	it("diffs a merge_group batch against the base the queue built it on", () => {
		expect(
			resolveBasis(event({eventName: "merge_group", baseRef: "", mergeGroupBaseSha: "abc123"})),
		).toEqual({_tag: "Range", base: "abc123"});
	});

	it("scans the whole tree on a push — that leg has no baseline, by design", () => {
		expect(resolveBasis(event({eventName: "push"}))).toEqual({_tag: "WholeTree"});
	});

	// A dispatch carries a ref, not a base; the dispatched branch targets the default branch and the
	// three-dot range resolves that to the merge-base (#5718).
	it("diffs a dispatched run against the default branch", () => {
		expect(resolveBasis(event({eventName: "workflow_dispatch", defaultBranch: "trunk"}))).toEqual({
			_tag: "Range",
			base: "origin/trunk",
		});
	});

	// The fail-open this module exists to close: the inline shell copies let an empty base reach
	// `git fetch origin ""`, and the diff silently became "nothing changed".
	it("refuses rather than inventing a base when both inputs are empty on an unknown event", () => {
		const resolved = resolveBasis(
			event({eventName: "issue_comment", baseRef: "", mergeGroupBaseSha: ""}),
		);
		expect(resolved._tag).toBe("Unresolvable");
		expect(resolved._tag === "Unresolvable" && resolved.reason).toContain("UNKNOWN");
	});

	it("refuses on an event it was never told the name of", () => {
		expect(resolveBasis(event({}))._tag).toBe("Unresolvable");
	});

	// Ordering: the merge-group sha is tested for CONTENT, not assumed from the event name, so a
	// whitespace-only value can never become a base.
	it("reads a whitespace-only input as absent, never as a base", () => {
		expect(resolveBasis(event({eventName: "push", baseRef: "  ", mergeGroupBaseSha: " "}))).toEqual(
			{
				_tag: "WholeTree",
			},
		);
	});

	it("trims the refs it does accept", () => {
		expect(resolveBasis(event({eventName: "pull_request", baseRef: " main\n"}))).toEqual({
			_tag: "Range",
			base: "origin/main",
		});
	});
});

describe("filesFor", () => {
	const run = (basis: Parameters<typeof filesFor>[0]) => {
		const shell = fakeShell([[/git/, {ok: true, stdout: "a.ts\0b.ts\0", reason: ""}]]);
		return Effect.runPromise(
			Effect.provide(filesFor(basis, "HEAD"), shell.layer).pipe(
				Effect.map((result) => ({result, calls: shell.calls})),
			),
		);
	};

	it("reads a Range basis out of the three-dot diff", async () => {
		const {result, calls} = await run({_tag: "Range", base: "origin/main"});
		expect(calls[0]).toContain("origin/main...HEAD");
		expect(result._tag === "Ok" && result.value).toEqual(["a.ts", "b.ts"]);
	});

	it("reads a WholeTree basis out of the tree listing, with no base at all", async () => {
		const {calls} = await run({_tag: "WholeTree"});
		expect(calls[0]).toContain("ls-tree");
		expect(calls[0]).not.toContain("...");
	});

	// An unreadable diff must not arrive as an empty file list — the caller has to be able to tell
	// "nothing changed" from "I could not ask".
	it("carries a failed read as a Failure, never as no files", async () => {
		const shell = fakeShell([[/git/, {ok: false, stdout: "", reason: "bad object"}]]);
		const result = await Effect.runPromise(
			Effect.provide(filesFor({_tag: "Range", base: "origin/main"}), shell.layer),
		);
		expect(result._tag).toBe("Failure");
	});
});
