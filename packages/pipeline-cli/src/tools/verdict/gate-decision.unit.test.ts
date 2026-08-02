import {assert, describe, it} from "@effect/vitest";
import {
	coverageDefect,
	decideGate,
	decideNamespace,
	type GateDecisionInput,
	parseRequiredGates,
} from "./gate-decision.ts";
import {isReviewed, type VerdictComment, type VerdictGate} from "./verdict-match.ts";

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

/**
 * The parse's gates, with the ok-branch ASSERTED rather than defaulted — a `?? []` here would let a
 * refusing parse silently gate on zero namespaces, which is the shape of the bug under test.
 */
const requiredOf = (occurrences: ReadonlyArray<string>): ReadonlyArray<VerdictGate> => {
	const parse = parseRequiredGates(occurrences);
	assert.strictEqual(parse._tag, "ok");
	return parse._tag === "ok" ? parse.gates : [];
};

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

describe("decideGate — PR #3955's exact situation: the in-force verdict was created FIRST (#4189)", () => {
	// The incident: `verdict post` upserts a verdict in place (#4016/#4050), so the live-head
	// advisories kept the `created_at` of the 00:09 slots they were rewritten into at 00:49, while a
	// superseded-head pair was created fresh at 00:32. Selecting by `(createdAt, id)` and testing the
	// head afterwards crowned the 00:32 pair, classified it `stale` — correctly — and refused a §CP PR
	// that was green on every required namespace, for ~an hour, with no surfaced reason.
	const UPSERTED_AT_HEAD = "2026-07-26T00:09:45Z";
	const CREATED_STALE = "2026-07-26T00:32:02Z";

	it("the live-head all-PASS advisories are selected over the newer-created dead-head pair", () => {
		const result = decide({
			requiredGates: ["code", "doc"],
			controlPlane: true,
			comments: [
				comment({id: 5081148335, createdAt: UPSERTED_AT_HEAD, body: advisory("doc", HEAD)}),
				comment({id: 5081149091, createdAt: UPSERTED_AT_HEAD, body: advisory("code", HEAD)}),
				comment({id: 5081217674, createdAt: CREATED_STALE, body: advisory("doc", OLD, "[FAIL]")}),
				comment({id: 5081217899, createdAt: CREATED_STALE, body: advisory("code", OLD)}),
			],
		});
		assert.isTrue(result.enqueueable);
		assert.deepStrictEqual(
			result.decisions.map((d) => d.commentId),
			[5081149091, 5081148335],
		);
	});

	it("a dead-head marker created later never shadows a live-head marker (non-§CP)", () => {
		const result = decide({
			comments: [
				comment({id: 1, createdAt: UPSERTED_AT_HEAD}),
				comment({
					id: 2,
					createdAt: CREATED_STALE,
					body: `review-doc: FAIL @ ${OLD} — changes-requested`,
				}),
			],
		});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.commentId, 1);
	});

	it("the head-first preference holds ACROSS the two forms: a live-head marker beats a newer dead-head advisory", () => {
		const result = decide({
			controlPlane: true,
			comments: [
				comment({
					id: 1,
					createdAt: UPSERTED_AT_HEAD,
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
				comment({id: 2, createdAt: CREATED_STALE, body: advisory("doc", OLD)}),
			],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "fail");
		assert.strictEqual(result.decisions[0]?.commentId, 1);
	});

	it("with NOTHING bound to the live head the refusal is unchanged — still the stale newest", () => {
		const result = decide({
			controlPlane: true,
			comments: [
				comment({id: 1, createdAt: UPSERTED_AT_HEAD, body: advisory("doc", OLD)}),
				comment({
					id: 2,
					createdAt: CREATED_STALE,
					body: `review-doc: PASS @ ${OLD} — merge-ready`,
				}),
			],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "unverified");
		assert.strictEqual(result.decisions[0]?.commentId, 2);
	});
});

describe("decideGate — two LIVE-HEAD verdicts order by write time, not slot-open time (#4200)", () => {
	// #4198's head-first filter admits BOTH candidates here (both bind the live head), so the tiebreak
	// among them is the whole decision — and unlike #4189's cross-head case there is no staleness test
	// downstream to convert a mis-pick into a refusal: whichever candidate wins is consumed at full
	// strength. `post` upserts in place, so the corrected verdict keeps its slot's `created_at` and
	// creation order runs INVERSE to write order.
	const SLOT_OPENED = "2026-07-26T00:09:58Z";
	const UPSERTED_AT = "2026-07-26T00:49:26Z";
	const SIBLING_CREATED = "2026-07-26T00:32:02Z";

	const written = (body: string, at: string) => `${body}\n\nVerdict-written: ${at}`;

	it("FAIL-OPEN closed: an older slot upserted to FAIL is not cleared by a newer-created same-head PASS", () => {
		const result = decide({
			comments: [
				comment({
					id: 1,
					createdAt: SLOT_OPENED,
					body: written(`review-doc: FAIL @ ${HEAD} — changes-requested`, UPSERTED_AT),
				}),
				comment({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: written(`review-doc: PASS @ ${HEAD} — merge-ready`, SIBLING_CREATED),
				}),
			],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "fail");
		assert.strictEqual(result.decisions[0]?.commentId, 1);
	});

	it("the §CP advisory form carries the same rule: a [FAIL] row upserted into an older slot still blocks", () => {
		const result = decide({
			controlPlane: true,
			comments: [
				comment({
					id: 1,
					createdAt: SLOT_OPENED,
					body: written(advisory("doc", HEAD, "[FAIL]"), UPSERTED_AT),
				}),
				comment({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: written(advisory("doc", HEAD), SIBLING_CREATED),
				}),
			],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "unverified");
		assert.strictEqual(result.decisions[0]?.commentId, 1);
	});

	it("the marker-vs-advisory fold uses the same key: an upserted marker outranks a newer-created advisory", () => {
		const result = decide({
			controlPlane: true,
			comments: [
				comment({
					id: 1,
					createdAt: SLOT_OPENED,
					body: written(`review-doc: FAIL @ ${HEAD} — changes-requested`, UPSERTED_AT),
				}),
				comment({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: written(advisory("doc", HEAD), SIBLING_CREATED),
				}),
			],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.state, "fail");
		assert.strictEqual(result.decisions[0]?.commentId, 1);
	});

	it("write order agreeing with creation order is unchanged latest-wins (#4016/#4050 preserved)", () => {
		const result = decide({
			comments: [
				comment({
					id: 1,
					createdAt: SLOT_OPENED,
					body: written(`review-doc: FAIL @ ${HEAD} — changes-requested`, SLOT_OPENED),
				}),
				comment({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: written(`review-doc: PASS @ ${HEAD} — merge-ready`, SIBLING_CREATED),
				}),
			],
		});
		assert.isTrue(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.commentId, 2);
	});

	it("unstamped pre-#4200 comments are unaffected — they order by created_at exactly as before", () => {
		const result = decide({
			comments: [
				comment({id: 1, createdAt: SLOT_OPENED}),
				comment({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
			],
		});
		assert.isFalse(result.enqueueable);
		assert.strictEqual(result.decisions[0]?.commentId, 2);
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

describe("`verdict read` and `verdict gate` resolve ONE in-force verdict (#4049)", () => {
	// PR #3988's marker set, the issue's own reference fixture: two FAILs and a superseding all-PASS
	// advisory, ALL THREE bound to the same live head, because the repair that discharged the FAIL was
	// body-only and deliberately did not move the head. ADR 0058 staleness therefore never fires, so
	// recency across the marker AND advisory candidate sets is the only thing that can retire the FAIL
	// — and `read`, which matched on polarity alone, could not see the advisory at all. Live before
	// this change: `gate --cp` said enqueueable while `read --expect FAIL` exited 0 on the same head.
	const FAIL_EARLY = comment({
		id: 1,
		createdAt: "2026-07-25T06:51:00Z",
		body: `review-code: FAIL @ ${HEAD} — not merge-ready`,
	});
	const FAIL_LATE = comment({
		id: 2,
		createdAt: "2026-07-25T19:16:31Z",
		body: `review-code: FAIL @ ${HEAD} — not merge-ready`,
	});
	const ADVISORY = comment({
		id: 3,
		createdAt: "2026-07-25T19:22:59Z",
		body: advisory("code", HEAD),
	});

	/** What `verdict read --gate code [--cp]` resolves — the same call `Github.read` makes. */
	const read = (comments: ReadonlyArray<VerdictComment>, controlPlane: boolean) =>
		decideNamespace("code", {
			comments,
			authorizedAuthors: [REVIEWER],
			headSha: HEAD,
			controlPlane,
		});

	const cases: ReadonlyArray<{
		readonly name: string;
		readonly comments: ReadonlyArray<VerdictComment>;
		readonly controlPlane: boolean;
		readonly tag: string;
		readonly commentId: number | null;
		readonly expectPass: boolean;
		readonly expectFail: boolean;
	}> = [
		{
			name: "§CP: the superseding all-PASS advisory is in force — the FAIL is no longer resolvable",
			comments: [FAIL_EARLY, FAIL_LATE, ADVISORY],
			controlPlane: true,
			tag: "current",
			commentId: 3,
			expectPass: true,
			expectFail: false,
		},
		{
			name: "the SAME set read WITHOUT --cp reproduces the pre-fix answer exactly (non-§CP unchanged)",
			comments: [FAIL_EARLY, FAIL_LATE, ADVISORY],
			controlPlane: false,
			tag: "current",
			commentId: 2,
			expectPass: false,
			expectFail: true,
		},
		{
			name: "§CP: a FAIL posted AFTER the advisory is in force again — supersession runs both ways",
			comments: [
				ADVISORY,
				comment({
					id: 4,
					createdAt: "2026-07-25T20:00:00Z",
					body: `review-code: FAIL @ ${HEAD} — not merge-ready`,
				}),
			],
			controlPlane: true,
			tag: "current",
			commentId: 4,
			expectPass: false,
			expectFail: true,
		},
		{
			name: "§CP: an advisory recording a [FAIL] criterion satisfies NEITHER expectation",
			comments: [comment({id: 5, body: advisory("code", HEAD, "[FAIL]")})],
			controlPlane: true,
			tag: "advisory-not-all-pass",
			commentId: 5,
			expectPass: false,
			expectFail: false,
		},
		{
			name: "§CP: an advisory whose Reviewed-head is stale is unverified, never a pass",
			comments: [comment({id: 6, body: advisory("code", OLD)})],
			controlPlane: true,
			tag: "stale",
			commentId: 6,
			expectPass: false,
			expectFail: false,
		},
		{
			name: "§CP: an anchor-less advisory binds no head ⇒ unverified (ADR 0151)",
			comments: [
				comment({
					id: 7,
					body: "review-code: advisory — blocking-set PR (manual merge)\n\n- [PASS] x",
				}),
			],
			controlPlane: true,
			tag: "sha-less",
			commentId: 7,
			expectPass: false,
			expectFail: false,
		},
		{
			name: "§CP: an unauthorized author's advisory is invisible (the ADR 0055 gate composes)",
			comments: [FAIL_LATE, comment({...ADVISORY, author: "attacker"})],
			controlPlane: true,
			tag: "current",
			commentId: 2,
			expectPass: false,
			expectFail: true,
		},
	];

	for (const {name, comments, controlPlane, tag, commentId, expectPass, expectFail} of cases) {
		it(name, () => {
			const decision = read(comments, controlPlane);
			assert.strictEqual(decision.outcome._tag, tag);
			assert.strictEqual(decision.commentId, commentId);
			assert.strictEqual(isReviewed(decision.outcome, "PASS"), expectPass);
			assert.strictEqual(isReviewed(decision.outcome, "FAIL"), expectFail);
		});

		// The AC2 invariant, asserted per row rather than argued: a `read --expect PASS` and a
		// single-namespace `verdict gate` over the identical inputs must agree. A second resolution
		// reintroduced on either side reds here even if both sides' own tests stay green.
		it(`${name} — gate agrees with read --expect PASS`, () => {
			const decision = read(comments, controlPlane);
			const gateResult = decideGate({
				comments,
				authorizedAuthors: [REVIEWER],
				requiredGates: ["code"],
				headSha: HEAD,
				controlPlane,
			});
			assert.strictEqual(gateResult.enqueueable, isReviewed(decision.outcome, "PASS"));
			assert.strictEqual(gateResult.decisions[0]?.state, decision.state);
			assert.strictEqual(gateResult.decisions[0]?.commentId, decision.commentId);
		});
	}
});

describe("parseRequiredGates — flag-shape parity (#4520)", () => {
	it("repeated occurrences and one comma-separated occurrence are the SAME set", () => {
		assert.deepStrictEqual(
			requiredOf(["review-code", "review-doc"]),
			requiredOf(["review-code,review-doc"]),
		);
	});

	it("the union is order-blind and covers every occurrence, not just the first", () => {
		assert.deepStrictEqual(requiredOf(["review-code", "review-doc"]), ["code", "doc"]);
		assert.deepStrictEqual(requiredOf(["skill", "review-code", "doc"]), ["skill", "code", "doc"]);
	});

	it("a bogus token in a LATER occurrence reaches the token guard (it used to vanish upstream)", () => {
		const parse = parseRequiredGates(["review-code", "bogus"]);
		assert.strictEqual(parse._tag, "error");
		if (parse._tag === "error") assert.include(parse.reason, "shrink the gate conjunction");
	});

	it("a bogus token in the FIRST occurrence still refuses (the shape that already worked)", () => {
		assert.strictEqual(parseRequiredGates(["bogus", "review-code"])._tag, "error");
	});

	it("an explicitly-empty value yields zero gates, which decideGate refuses on zero scope", () => {
		assert.deepStrictEqual(requiredOf([""]), []);
		assert.isFalse(decide({requiredGates: []}).enqueueable);
	});
});

describe("the repeated --require shape gates on EVERY namespace (#4520 acceptance)", () => {
	// The live repro: review-code PASSes at head, review-doc has no verdict at all. The old
	// single-valued flag dropped review-doc and cleared the enqueue; the union must refuse.
	const codePass = comment({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`});

	it("an absent verdict in the LATER-occurrence namespace refuses", () => {
		const result = decide({
			comments: [codePass],
			requiredGates: requiredOf(["review-code", "review-doc"]),
		});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "no review-doc PASS");
	});

	it("a live FAIL in the LATER-occurrence namespace refuses", () => {
		const result = decide({
			comments: [
				codePass,
				comment({id: 2, body: `review-doc: FAIL @ ${HEAD} — changes-requested`}),
			],
			requiredGates: requiredOf(["review-code", "review-doc"]),
		});
		assert.isFalse(result.enqueueable);
		assert.include(result.reason, "latest verdict is FAIL (review-doc)");
	});

	it("both spellings of the same requirement decide identically", () => {
		const comments = [codePass];
		const repeated = decide({
			comments,
			requiredGates: requiredOf(["review-code", "review-doc"]),
		});
		const commaJoined = decide({
			comments,
			requiredGates: requiredOf(["review-code,review-doc"]),
		});
		assert.strictEqual(repeated.enqueueable, commaJoined.enqueueable);
		assert.strictEqual(repeated.reason, commaJoined.reason);
	});
});

describe("coverageDefect — an affirmative answer must cover every namespace asked (#4520)", () => {
	const passing = decide({
		comments: [comment({id: 1, body: `review-doc: PASS @ ${HEAD} — merge-ready`})],
	});

	it("no defect when the answer covers exactly the distinct requested set", () => {
		assert.isNull(coverageDefect(["doc"], passing));
	});

	it("duplicates in the request are not a defect — the core dedups the set", () => {
		assert.isNull(coverageDefect(["doc", "doc"], passing));
	});

	it("a pass that decided FEWER namespaces than were asked is refused, and names the missing one", () => {
		const defect = coverageDefect(["doc", "code"], passing);
		assert.isNotNull(defect);
		assert.include(defect ?? "", "NEVER decided: code");
	});

	it("a pass that decided a namespace nobody asked for is refused too", () => {
		assert.include(coverageDefect([], passing) ?? "", "decided unasked: doc");
	});
});
