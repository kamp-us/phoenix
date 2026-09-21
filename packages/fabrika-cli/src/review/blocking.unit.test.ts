import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, linkNext, type Scripted} from "../fakes.test-support.ts";
import {httpError, PROTECTION, protection, RULES, rules} from "../heal-ci/fixtures.test-support.ts";
import {
	authorityNote,
	blockingSet,
	readBlockingSet,
	reportedLine,
	unreadableCause,
} from "./blocking.ts";

const read = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(readBlockingSet("o/r", "main"), fakeSeams(script).layer));

describe("blockingSet — which definition answers", () => {
	it("makes the declared contexts the whole blocking set", () => {
		const set = blockingSet(["ci-required", "Analyze (python)"]);
		expect(set.token).toBe("required");
		expect(set.blocks("ci-required")).toBe(true);
		expect(set.blocks("Analyze (python)")).toBe(true);
	});

	it("reports a red no declared context names, however ordinary its name", () => {
		const set = blockingSet(["ci-required"]);
		expect(set.blocks("unit tests")).toBe(false);
		expect(set.blocks("code-scanning/codeql")).toBe(false);
	});

	// The denylist is the fallback and nothing else: a branch that declares nothing is one nobody has
	// said what gates, so the older name-denylist definition still holds over it.
	it("falls back to the informational denylist on a branch that declares nothing", () => {
		const set = blockingSet([]);
		expect(set.token).toBe("no-requirements");
		expect(set.blocks("unit tests")).toBe(true);
		expect(set.blocks("deploy (web)")).toBe(false);
		expect(set.blocks("cleanup stale previews")).toBe(false);
	});

	it("matches a context as the platform names it, never case-folded or prefixed", () => {
		const set = blockingSet(["ci-required"]);
		expect(set.blocks("CI-Required")).toBe(false);
		expect(set.blocks("ci-required (unit)")).toBe(false);
	});
});

describe("readBlockingSet over the three read outcomes", () => {
	it("answers a required set from protection ∪ the rulesets that match the base", async () => {
		const answered = await read([
			[RULES, rules("ci-required")],
			[PROTECTION, protection("governance floor at head")],
		]);
		expect(answered._tag).toBe("Set");
		if (answered._tag !== "Set") return;
		expect(answered.set.token).toBe("required");
		expect([...answered.set.contexts].sort()).toEqual(["ci-required", "governance floor at head"]);
	});

	it("answers no-requirements only on a successful read that named zero contexts", async () => {
		const answered = await read([
			[RULES, rules()],
			[PROTECTION, httpError(404, "Branch not protected")],
		]);
		expect(answered._tag).toBe("Set");
		if (answered._tag !== "Set") return;
		expect(answered.set.token).toBe("no-requirements");
	});

	// The 404 above is ambiguous by construction, so a permission denial must never wear the same
	// answer: one says the branch declares nothing, the other that nobody could look.
	it("keeps a permission denial unprobeable rather than collapsing it into no-requirements", async () => {
		const answered = await read([
			[RULES, httpError(403, "Resource not accessible by integration")],
		]);
		expect(answered._tag).toBe("Unprobeable");
	});

	it("is unprobeable when the rules read passes and protection is denied", async () => {
		const answered = await read([
			[RULES, rules("ci-required")],
			[PROTECTION, httpError(401, "Bad credentials")],
		]);
		expect(answered._tag).toBe("Unprobeable");
	});

	it("is Unknown, never unprobeable, on a failure that is not this token's permission", async () => {
		const answered = await read([[RULES, httpError(500, "server error")]]);
		expect(answered._tag).toBe("Unknown");
	});

	it("refuses an unexhausted ruleset walk rather than reading a short page as the whole set", async () => {
		const answered = await read([
			[RULES, {...rules("ci-required"), headers: linkNext("https://api.github.com/next")}],
		]);
		expect(answered._tag).toBe("Incomplete");
	});
});

describe("the lines a verb prints about its authority", () => {
	it("names the read failure as the cause, never a check's colour", () => {
		const line = unreadableCause("review ci", "main", {
			_tag: "Unprobeable",
			reason: "Resource not accessible by integration",
		});
		expect(line).toContain("cannot read main's required status checks");
		expect(line).toContain("Resource not accessible by integration");
		expect(line).toContain("UNKNOWN, never none.");
	});

	it("says which definition answered, so the answer carries its own authority", () => {
		expect(authorityNote("ship checks", "main", blockingSet(["ci-required"]))).toContain(
			"main declares 1 required context(s): ci-required",
		);
		expect(authorityNote("ship checks", "main", blockingSet([]))).toContain(
			"declares no required status checks",
		);
	});

	it("names every non-required red, and says nothing when there is none", () => {
		expect(reportedLine("ship checks", ["Analyze (python)", "deploy (web)"])).toEqual([
			"ship checks: failing outside the required set: Analyze (python), deploy (web) — reported, never blocking.",
		]);
		expect(reportedLine("ship checks", [])).toEqual([]);
	});
});
