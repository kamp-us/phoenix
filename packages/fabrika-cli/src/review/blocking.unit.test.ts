import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, linkNext, type Scripted} from "../fakes.test-support.ts";
import {
	httpError,
	PROTECTION,
	planGated,
	protection,
	RULES,
	rules,
} from "../heal-ci/fixtures.test-support.ts";
import {
	authorityNote,
	blockingSet,
	noBlockingRunNote,
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

	// A private repository on the free plan: no token can read either surface, and no branch there
	// can declare a required check, so the answer is the undeclared branch's, not an UNKNOWN.
	it("answers no-requirements when the rules read is plan-gated", async () => {
		const answered = await read([[RULES, planGated]]);
		expect(answered._tag).toBe("Set");
		if (answered._tag !== "Set") return;
		expect(answered.set.token).toBe("no-requirements");
		expect(answered.set.contexts).toEqual([]);
		expect(answered.set.blocks("unit tests")).toBe(true);
		expect(answered.set.blocks("deploy (web)")).toBe(false);
	});

	it("answers no-requirements when the rules read passes and protection is plan-gated", async () => {
		const answered = await read([
			[RULES, rules()],
			[PROTECTION, planGated],
		]);
		expect(answered._tag).toBe("Set");
		if (answered._tag !== "Set") return;
		expect(answered.set.token).toBe("no-requirements");
	});

	it("keeps a 403 carrying any other message unprobeable on either read", async () => {
		expect((await read([[RULES, httpError(403, "Must have admin rights")]]))._tag).toBe(
			"Unprobeable",
		);
		expect(
			(
				await read([
					[RULES, rules()],
					[PROTECTION, httpError(403, "Upgrade your plan")],
				])
			)._tag,
		).toBe("Unprobeable");
	});

	// The match reads GitHub's own `message`, so a plan-gate wording on any other status is no gate.
	it("reads the plan-gate wording as a gate only on a 403", async () => {
		const answered = await read([
			[RULES, httpError(401, "Upgrade to GitHub Pro or make this repository public")],
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

	it("names the plan gate, not an undeclared branch, when the plan offers no protection", async () => {
		const answered = await read([[RULES, planGated]]);
		if (answered._tag !== "Set") throw new Error(`expected a set, got ${answered._tag}`);
		const note = authorityNote("review ci", "main", answered.set);
		expect(note).toContain(
			"main's plan offers no branch protection or rulesets — every non-informational check blocks",
		);
		expect(note).not.toContain("declares no required status checks");
	});

	it("says why a head with no blocking run may not read green", () => {
		expect(noBlockingRunNote("ship checks", "main", blockingSet(["ci-required"]))).toContain(
			"no run at this head answers any context main declares required — pending, never green",
		);
		expect(noBlockingRunNote("ship checks", "main", blockingSet([]))).toContain(
			"every run at this head is informational — pending, never green",
		);
	});

	it("names every non-required red, and says nothing when there is none", () => {
		expect(reportedLine("ship checks", ["Analyze (python)", "deploy (web)"])).toEqual([
			"ship checks: failing outside the required set: Analyze (python), deploy (web) — reported, never blocking.",
		]);
		expect(reportedLine("ship checks", [])).toEqual([]);
	});
});
