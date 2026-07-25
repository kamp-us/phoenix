import {assert, describe, it} from "@effect/vitest";
import {decideGate, type GateDecisionInput} from "./gate-decision.ts";
import {
	isReviewed,
	resolveVerdict,
	type VerdictComment,
	type VerdictGate,
	verdictState,
} from "./verdict-match.ts";

const HEAD = "15ae9df658ce6225b8b71f22d214cfcabb6b1c9a";
const OLD = "92c2cf4d0000000000000000000000000000abcd";
const REVIEWER = "usirin";

const comment = (over: Partial<VerdictComment> & {readonly id: number}): VerdictComment => ({
	author: REVIEWER,
	createdAt: "2026-07-25T04:54:53Z",
	body: `review-doc: PASS @ ${HEAD} — merge-ready`,
	...over,
});

const decide = (over: Partial<GateDecisionInput>) =>
	decideGate({
		comments: [],
		authorizedAuthors: [REVIEWER],
		requiredGates: ["doc"],
		headSha: HEAD,
		controlPlane: false,
		...over,
	});

/** The §CP advisory shape ship-it Step 2.§CP resolves: SHA-less line 1, head bound in the body. */
const advisory = (gate: VerdictGate, sha: string, checkbox = "[PASS]") =>
	[
		`review-${gate}: advisory — blocking-set PR (manual merge)`,
		"",
		`Reviewed-head: @ ${sha}`,
		"",
		`- ${checkbox} the gate's own criteria`,
	].join("\n");

describe("decideGate — the required-namespace conjunction (the enqueue decision)", () => {
	it("a current-head PASS marker in the one required namespace is enqueueable", () => {
		const result = decide({comments: [comment({id: 1})]});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "pass");
		assert.strictEqual(result.decisions[0]?.form, "marker");
	});

	it("a current-head FAIL marker refuses, and the reason names the FAIL", () => {
		const result = decide({
			comments: [comment({id: 1, body: `review-doc: FAIL @ ${HEAD} — changes-requested`})],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "fail");
		assert.include(result.reason, "latest verdict is FAIL (review-doc)");
	});

	it("NO verdict at all in a required namespace refuses (the absence hole, #3982)", () => {
		const result = decide({comments: []});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "absent");
		assert.include(result.reason, "no review-doc PASS");
	});

	it("an unauthorized author's current-head PASS is invisible ⇒ absent (ADR 0055 trust root)", () => {
		const result = decide({
			comments: [comment({id: 1, author: "a-stranger"})],
			authorizedAuthors: [REVIEWER],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "absent");
	});

	it("an empty authorized set resolves absent for every namespace (fail-closed)", () => {
		const result = decide({comments: [comment({id: 1})], authorizedAuthors: []});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "absent");
	});

	it("a SHA-less (pre-0058) marker refuses as unverified, never as a pass", () => {
		const result = decide({comments: [comment({id: 1, body: "review-doc: PASS — merge-ready"})]});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "unverified");
		assert.include(result.reason, "not bound to current head");
	});

	it("latest-wins: a newer current-head FAIL vetoes an older current-head PASS", () => {
		const result = decide({
			comments: [
				comment({id: 1, createdAt: "2026-07-25T05:11:56Z"}),
				comment({
					id: 2,
					createdAt: "2026-07-25T05:18:37Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
			],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "fail");
	});

	it("latest-wins: a newer current-head PASS clears an older FAIL (the repair loop)", () => {
		const result = decide({
			comments: [
				comment({
					id: 1,
					createdAt: "2026-07-25T04:54:53Z",
					body: `review-doc: FAIL @ ${OLD} — changes-requested`,
				}),
				comment({id: 2, createdAt: "2026-07-25T05:11:56Z"}),
			],
		});
		assert.isTrue(result.enqueueable);
	});
});

describe("decideGate — PR #3944's exact situation: a verdict bound to a SUPERSEDED head", () => {
	// The incident (#3982): PR #3944 opened at head 92c2cf4d, took a review-doc FAIL bound to THAT
	// head, then got a repair push moving the head to 15ae9df6. At `added_to_merge_queue` the only
	// verdict on the PR was that FAIL, bound to the superseded 92c2cf4d — i.e. NOTHING was bound to
	// the live head, and the enqueue proceeded anyway. The defect is the absence branch, not
	// FAIL-detection: a stale verdict of EITHER polarity leaves the live head un-attested, so both
	// polarities must refuse here.
	const staleCases: ReadonlyArray<{readonly name: string; readonly polarity: "PASS" | "FAIL"}> = [
		{name: "stale FAIL at the superseded head (the observed #3944 state)", polarity: "FAIL"},
		{name: "stale PASS at the superseded head (the head-moved race)", polarity: "PASS"},
	];

	for (const {name, polarity} of staleCases) {
		it(`${name} ⇒ MUST refuse`, () => {
			const result = decide({
				comments: [comment({id: 5077016090, body: `review-doc: ${polarity} @ ${OLD} — round 1`})],
			});
			assert.isFalse(result.enqueueable);
			assert.strictEqual(result.decisions[0]?.state, "unverified");
			assert.strictEqual(result.decisions[0]?.sha, OLD);
			assert.include(result.reason, "not bound to current head");
		});
	}

	it("the repaired head with a fresh current-head PASS is what unblocks it", () => {
		const result = decide({
			comments: [
				comment({
					id: 5077016090,
					createdAt: "2026-07-25T04:54:53Z",
					body: `review-doc: FAIL @ ${OLD} — round 1`,
				}),
				comment({
					id: 5077016099,
					createdAt: "2026-07-25T05:11:56Z",
					body: `review-doc: PASS @ ${HEAD} — merge-ready`,
				}),
			],
		});
		assert.isTrue(result.enqueueable);
	});
});

describe("decideGate — the §CP advisory is the pass, and only on a §CP PR (ADR 0111/0151)", () => {
	it("a §CP advisory bound to the current head passes", () => {
		const result = decide({
			comments: [comment({id: 1, body: advisory("doc", HEAD)})],
			controlPlane: true,
		});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "pass");
		assert.strictEqual(result.decisions[0]?.form, "advisory");
		assert.strictEqual(result.decisions[0]?.sha, HEAD);
	});

	it("a §CP review-code advisory passes too — all four gates converge on the one form (#2329)", () => {
		const result = decide({
			comments: [comment({id: 1, body: advisory("code", HEAD)})],
			requiredGates: ["code"],
			controlPlane: true,
		});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.form, "advisory");
	});

	it("a §CP PR is NOT required to carry a bindable first-line PASS (the ADR 0111 hazard)", () => {
		// The advisory alone clears it: nothing in the decision demands `review-doc: PASS @ <sha>`
		// on a §CP PR, so the forge-a-marker workaround stays unnecessary.
		const result = decide({
			comments: [comment({id: 1, body: advisory("doc", HEAD)})],
			controlPlane: true,
		});
		assert.isTrue(result.enqueueable);
		assert.notInclude(JSON.stringify(result.decisions), '"form":"marker"');
	});

	it("a §CP advisory bound to a stale head refuses", () => {
		const result = decide({
			comments: [comment({id: 1, body: advisory("doc", OLD)})],
			controlPlane: true,
		});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "advisory reviewed-head stale");
	});

	it("a §CP advisory with no Reviewed-head body binding refuses", () => {
		const result = decide({
			comments: [comment({id: 1, body: "review-doc: advisory — blocking-set PR (manual merge)"})],
			controlPlane: true,
		});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "no 'Reviewed-head: @ <sha>' body binding");
	});

	it("a §CP advisory carrying a [FAIL] checkbox refuses (not all-PASS)", () => {
		const result = decide({
			comments: [comment({id: 1, body: advisory("doc", HEAD, "[FAIL]")})],
			controlPlane: true,
		});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "not all-PASS");
	});

	it("a §CP advisory never masks a NEWER current-head FAIL marker", () => {
		const result = decide({
			comments: [
				comment({id: 1, createdAt: "2026-07-25T05:00:00Z", body: advisory("doc", HEAD)}),
				comment({
					id: 2,
					createdAt: "2026-07-25T05:30:00Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
			],
			controlPlane: true,
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "fail");
	});

	// The OPPOSITE direction of the case above, and the one that was left unpinned: a NEWER advisory
	// out-ranking an OLDER same-head FAIL. This is not a nicety — it is the only exit from #4049. A
	// body-only repair answers a finding without moving the head, so the old FAIL stays
	// current-head-bound forever and head-keyed staleness (ADR 0058 rule 3) never fires. Latest-wins
	// across the marker AND advisory candidate sets is what lets the superseding advisory clear it;
	// any rule that makes a current-head FAIL an unconditional veto re-wedges every such PR (it is
	// how PR #3988 got unstuck and how #3998 shipped). Pinned here because a veto reinstated in
	// `decideGate`/`resolveVerdict` would otherwise pass the whole suite green — see ADR 0213
	// §"Rejected: a current-head FAIL veto".
	it("a NEWER §CP advisory out-ranks an OLDER same-head FAIL (the #4049 body-only-repair exit)", () => {
		const result = decide({
			comments: [
				comment({
					id: 1,
					createdAt: "2026-07-25T05:00:00Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
				comment({id: 2, createdAt: "2026-07-25T05:30:00Z", body: advisory("doc", HEAD)}),
			],
			controlPlane: true,
		});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "pass");
		assert.strictEqual(result.decisions[0]?.form, "advisory");
		assert.strictEqual(result.decisions[0]?.commentId, 2);
	});

	it("same createdAt, advisory has the larger id ⇒ the advisory still supersedes the FAIL", () => {
		const result = decide({
			comments: [
				comment({
					id: 1,
					createdAt: "2026-07-25T05:00:00Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
				comment({id: 2, createdAt: "2026-07-25T05:00:00Z", body: advisory("doc", HEAD)}),
			],
			controlPlane: true,
		});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.form, "advisory");
	});

	it("on a NON-§CP PR an advisory is not a pass — it resolves absent", () => {
		const result = decide({comments: [comment({id: 1, body: advisory("doc", HEAD)})]});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "absent");
	});

	it("on a NON-§CP PR an advisory does not shadow an older bindable PASS", () => {
		const result = decide({
			comments: [
				comment({id: 1, createdAt: "2026-07-25T05:00:00Z"}),
				comment({id: 2, createdAt: "2026-07-25T05:30:00Z", body: advisory("doc", HEAD)}),
			],
		});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.form, "marker");
	});
});

describe("decideGate — EVERY required namespace must pass, not just one", () => {
	it("an ADR + a .glossary row requires BOTH review-doc and review-code; one PASS is not enough", () => {
		// `.glossary/**` rides has-code (HAS_CODE_RE = ^(apps|packages|\.glossary|infra)/), so such a
		// diff spans has-docs + has-code — the #2430 miss ship-it's conjunction caught late.
		const result = decide({
			requiredGates: ["doc", "code"],
			comments: [comment({id: 1})],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions.length, 2);
		assert.strictEqual(result.decisions[0]?.state, "pass");
		assert.strictEqual(result.decisions[1]?.state, "absent");
		assert.include(result.reason, "no review-code PASS");
	});

	it("both namespaces at the current head ⇒ enqueueable", () => {
		const result = decide({
			requiredGates: ["doc", "code"],
			comments: [
				comment({id: 1}),
				comment({id: 2, body: `review-code: PASS @ ${HEAD} — merge-ready`}),
			],
		});
		assert.isTrue(result.enqueueable);
	});

	it("a UI PR's additive review-design namespace is required alongside review-code", () => {
		const result = decide({
			requiredGates: ["code", "design"],
			comments: [comment({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "no review-design PASS");
	});

	it("a FAIL is reported ahead of an absence — its remedy is the author's repair round-trip", () => {
		const result = decide({
			requiredGates: ["doc", "code"],
			comments: [comment({id: 1, body: `review-doc: FAIL @ ${HEAD} — changes-requested`})],
		});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "latest verdict is FAIL (review-doc)");
	});

	it("a repeated namespace is decided once (the set, not the list)", () => {
		const result = decide({requiredGates: ["doc", "doc"], comments: [comment({id: 1})]});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions.length, 1);
	});
});

describe("decideGate — fail-closed on its own inputs (ADR 0092)", () => {
	it("an EMPTY required set refuses rather than passing vacuously", () => {
		const result = decide({requiredGates: [], comments: [comment({id: 1})]});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "zero scope");
	});

	it("an empty/unresolvable head SHA refuses", () => {
		const result = decide({headSha: "", comments: [comment({id: 1})]});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "head SHA is empty");
	});

	it("an abbreviated head still prefix-matches a full bound SHA (ADR 0058 rule 3)", () => {
		const result = decide({headSha: HEAD.slice(0, 8), comments: [comment({id: 1})]});
		assert.isTrue(result.enqueueable);
	});
});

/**
 * The cross-consumer invariant (#4049): `read` and `gate` must name the SAME in-force verdict for
 * the same (PR, gate, head, §CP-ness) inputs. They diverged because each computed its own — `read`
 * by polarity-matching, `gate` by latest-wins across marker AND advisory — so on a §CP PR whose
 * body-only repair left the head unmoved, `read` kept resolving a superseded FAIL as current while
 * `gate` correctly saw the newer advisory. Both now project one resolution; this table is what
 * fails if a second one is ever reintroduced.
 */
describe("read and gate agree on the in-force verdict (#4049)", () => {
	const FAIL_AT_HEAD = `review-doc: FAIL @ ${HEAD} — changes-requested`;
	const fixtures: ReadonlyArray<{
		readonly name: string;
		readonly comments: ReadonlyArray<VerdictComment>;
		readonly controlPlane: boolean;
	}> = [
		{
			name: "the PR #3988 body-only-repair set on a §CP PR: FAIL, FAIL, all-PASS advisory @ one head",
			comments: [
				comment({id: 1, createdAt: "2026-07-24T06:51:00Z", body: FAIL_AT_HEAD}),
				comment({id: 2, createdAt: "2026-07-24T19:16:00Z", body: FAIL_AT_HEAD}),
				comment({id: 3, createdAt: "2026-07-24T19:22:00Z", body: advisory("doc", HEAD)}),
			],
			controlPlane: true,
		},
		{
			name: "the same set on a non-§CP PR",
			comments: [
				comment({id: 1, createdAt: "2026-07-24T06:51:00Z", body: FAIL_AT_HEAD}),
				comment({id: 2, createdAt: "2026-07-24T19:16:00Z", body: FAIL_AT_HEAD}),
				comment({id: 3, createdAt: "2026-07-24T19:22:00Z", body: advisory("doc", HEAD)}),
			],
			controlPlane: false,
		},
		{
			name: "§CP, a FAIL posted after the advisory",
			comments: [
				comment({id: 1, createdAt: "2026-07-24T19:00:00Z", body: advisory("doc", HEAD)}),
				comment({id: 2, createdAt: "2026-07-24T19:22:00Z", body: FAIL_AT_HEAD}),
			],
			controlPlane: true,
		},
		{
			name: "§CP, the advisory is not all-PASS",
			comments: [
				comment({id: 1, createdAt: "2026-07-24T06:51:00Z", body: FAIL_AT_HEAD}),
				comment({id: 2, createdAt: "2026-07-24T19:22:00Z", body: advisory("doc", HEAD, "[FAIL]")}),
			],
			controlPlane: true,
		},
		{
			name: "§CP, the advisory's Reviewed-head is stale",
			comments: [comment({id: 1, body: advisory("doc", OLD)})],
			controlPlane: true,
		},
		{name: "an empty namespace", comments: [], controlPlane: true},
	];

	for (const {name, comments, controlPlane} of fixtures) {
		it(name, () => {
			const outcome = resolveVerdict({
				comments,
				authorizedAuthors: [REVIEWER],
				gate: "doc",
				headSha: HEAD,
				controlPlane,
			});
			const decision = decideGate({
				comments,
				authorizedAuthors: [REVIEWER],
				requiredGates: ["doc"],
				headSha: HEAD,
				controlPlane,
			}).decisions[0];
			assert.strictEqual(verdictState(outcome), decision?.state);
			assert.strictEqual(outcome.form, decision?.form);
			// The two exit codes a consumer branches on: ship-it's `--expect PASS` must agree with
			// `enqueueable`, and write-code's repair seam `--expect FAIL` must agree with the veto.
			assert.strictEqual(isReviewed(outcome, "PASS"), decision?.state === "pass");
			assert.strictEqual(isReviewed(outcome, "FAIL"), decision?.state === "fail");
		});
	}
});
