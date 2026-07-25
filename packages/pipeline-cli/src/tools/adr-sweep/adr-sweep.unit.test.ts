/**
 * The pure `adr-sweep` core: term extraction, citation parsing, live-status scope, the ranked
 * shortlist, and the two fail-closed refusals.
 *
 * The last block is the **would-have-caught** check (#3980 AC 4): condensed but faithful
 * fixtures of the two live misses — ADR 0208 vs accepted 0072, ADR 0210 vs accepted 0202 —
 * asserting the sweep surfaces the ADR each one silently re-decided against. The companion
 * negative asserts the honest limit: a contradiction carried entirely by what a shared label
 * MEANS, with no shared vocabulary, does not surface.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	citedIds,
	decisionText,
	isLiveAccepted,
	parseTags,
	SweepScopeError,
	sweep,
	termsOf,
} from "./adr-sweep.ts";

const adr = ({
	id,
	title,
	status = "accepted",
	tags = ["pipeline"],
	decides = "",
	decision = "",
	context = "",
}: {
	id: string;
	title: string;
	status?: string;
	tags?: ReadonlyArray<string>;
	decides?: string;
	decision?: string;
	context?: string;
}) => ({
	file: `${id}-fixture.md`,
	text: [
		"---",
		`id: ${id}`,
		`title: ${title}`,
		`status: ${status}`,
		"date: 2026-07-25",
		`tags: [${tags.join(", ")}]`,
		"---",
		"",
		`# ${id} — ${title}`,
		"",
		`**What this decides:** ${decides}`,
		"",
		"## Context",
		context,
		"",
		"## Decision",
		decision,
		"",
		"## Consequences",
		"Filler consequence prose that must not feed the sweep.",
		"",
	].join("\n"),
});

/** Unrelated ADRs so the IDF table has a corpus to price rarity against. */
const filler = (n: number) =>
	Array.from({length: n}, (_, i) =>
		adr({
			id: String(900 + i).padStart(4, "0"),
			title: `Filler decision ${i} about rendering and caching`,
			tags: ["frontend"],
			decides: `Filler ${i} governs rendering, caching, and hydration of the widget surface.`,
			decision: `Rendering uses the cached widget snapshot ${i}; hydration never blocks paint.`,
		}),
	);

describe("termsOf / decisionText — what the sweep keys on", () => {
	it("keeps distinctive tokens and drops stopwords, short words, and bare numbers", () => {
		const terms = termsOf("Milestones encode strategic sequencing, not 1234 feature breakdown");
		expect([...terms].sort()).toEqual([
			"breakdown",
			"encode",
			"feature",
			"milestone",
			"sequencing",
			"strategic",
		]);
	});

	it("de-pluralizes so `milestones` and `milestone` are one term, but never strips an -ss word", () => {
		expect([...termsOf("milestones milestone process")].sort()).toEqual(["milestone", "process"]);
	});

	it("reads a markdown link's label, not its slug — a cited ADR's slug must not inflate overlap", () => {
		// `extends` → `extend`: the crude de-pluralizer collapses a trailing -s on verbs too, which
		// is harmless (it only ever merges two spellings of one token).
		expect([...termsOf("extends [0202](0202-forward-motion-doctrine-crewops.md) here")]).toEqual([
			"extend",
		]);
	});

	it("scopes to title + `What this decides` + `## Decision`, excluding Context and Consequences", () => {
		const doc = adr({
			id: "0500",
			title: "Titleword",
			decides: "Decidesword rules.",
			decision: "Decisionword binds.",
			context: "Contextword narrates.",
		});
		const text = decisionText("Titleword", doc.text);
		expect(text).toContain("Titleword");
		expect(text).toContain("Decidesword");
		expect(text).toContain("Decisionword");
		expect(text).not.toContain("Contextword");
		expect(text).not.toContain("Filler consequence");
	});
});

describe("citedIds — narrow by design (a miss is noise, an over-match is a silent drop)", () => {
	it("reads a filename reference, a bracket reference, and an `ADR NNNN` run", () => {
		const cited = citedIds(
			"See [0072](0072-milestones-encode.md), ADR 0092/0107, and ADR [0055] for the rule.",
		);
		expect([...cited].sort()).toEqual(["0055", "0072", "0092", "0107"]);
	});

	it("does not read an issue number as an ADR citation", () => {
		expect([...citedIds("filed as #3980 after the 2026 sweep")]).toEqual([]);
	});
});

describe("isLiveAccepted — an amended ADR still rules over what the amendment did not touch", () => {
	it.each([
		["accepted", true],
		["amended-in-part by [0208](0208-slug.md)", true],
		["proposed", false],
		["superseded by [0009](0009-slug.md)", false],
		["retired", false],
		["reference", false],
	])("%s → %s", (status, live) => {
		expect(isLiveAccepted(status)).toBe(live);
	});
});

describe("sweep — fail-closed refusals (ADR 0092: zero scope reds, it never passes silently)", () => {
	it("refuses a corpus that holds no ADR other than the subject", () => {
		const subject = adr({id: "0500", title: "Alone", decides: "Nothing else exists."});
		expect(() => sweep({newAdr: subject, corpus: [subject]})).toThrow(SweepScopeError);
	});

	it("refuses a corpus with no live-accepted ADR rather than report a clean sweep", () => {
		const subject = adr({id: "0500", title: "Subject", decides: "Milestones are optional."});
		const dead = adr({
			id: "0400",
			title: "Retired rule",
			status: "superseded by [0500](0500-fixture.md)",
			decides: "Milestones are mandatory.",
		});
		expect(() => sweep({newAdr: subject, corpus: [subject, dead]})).toThrow(/zero live-accepted/);
	});

	it("refuses a corpus file with malformed front-matter", () => {
		const subject = adr({id: "0500", title: "Subject", decides: "A rule."});
		expect(() =>
			sweep({newAdr: subject, corpus: [subject, {file: "0400-broken.md", text: "no frontmatter"}]}),
		).toThrow(SweepScopeError);
	});
});

describe("sweep — `indeterminate` is a distinct outcome from `no-overlap`", () => {
	it("reports `indeterminate` when the subject yields no decision terms to key on", () => {
		const subject = {
			file: "0500-empty.md",
			text: "---\nid: 0500\ntitle: a\nstatus: accepted\ndate: 2026-07-25\ntags: []\n---\n\nbody\n",
		};
		const result = sweep({newAdr: subject, corpus: [subject, ...filler(12)]});
		expect(result.outcome._tag).toBe("indeterminate");
		expect(result.termCount).toBe(0);
	});

	it("reports `indeterminate` on a corpus too small for rarity — never a clean sweep", () => {
		const subject = adr({
			id: "0500",
			title: "Turnstile quota governs kefil vouches",
			decides: "A kefil vouch consumes a turnstile quota unit.",
		});
		const result = sweep({newAdr: subject, corpus: [subject, ...filler(4)]});
		expect(result.outcome._tag).toBe("indeterminate");
		expect(result.outcome).toMatchObject({reason: expect.stringContaining("degenerate silence")});
	});

	it("reports `indeterminate`, never `no-overlap`, when every live ADR is already cited", () => {
		const cited = filler(3);
		const subject = adr({
			id: "0500",
			title: "Cites everything",
			decides: `Extends ${cited.map((c) => `ADR ${c.file.slice(0, 4)}`).join(", ")}.`,
		});
		const result = sweep({newAdr: subject, corpus: [subject, ...cited]});
		expect(result.outcome._tag).toBe("indeterminate");
	});

	it("reports `no-overlap` when the swept set shares no distinctive vocabulary", () => {
		const subject = adr({
			id: "0500",
			title: "Turnstile quota governs kefil vouches",
			tags: ["moderation"],
			decides: "A kefil vouch consumes a turnstile quota unit.",
			decision: "Every kefil vouch decrements the turnstile quota.",
		});
		const result = sweep({newAdr: subject, corpus: [subject, ...filler(14)]});
		expect(result.outcome._tag).toBe("no-overlap");
	});
});

// Condensed but faithful fixtures of the four ADRs in the two live misses. The decision text is
// excerpted from each ADR's title / `What this decides` / `## Decision`; the surrounding prose is
// dropped because the sweep never reads it.
const ADR_0072 = adr({
	id: "0072",
	title: "Milestones Encode Strategic Sequencing, Not Feature Breakdown",
	tags: ["pipeline", "roadmap", "triage"],
	decides:
		"A milestone encodes strategic sequencing, not feature breakdown, and it is an optional pipeline dimension.",
	decision:
		"Milestone is an optional pipeline dimension alongside type, priority and status. " +
		"Deliberately leaving a cluster unmilestoned is itself the signal that it is parked or deferred: " +
		"absence is meaningful, so never invent milestone homes for frozen work. " +
		"If every open issue gets a milestone, absence stops meaning anything and the deferral signal is lost.",
});

const ADR_0208 = adr({
	id: "0208",
	title:
		"Standing lanes exempt from 100%-homed — exactly `wayfinder:backlog` + `axis:pipeline-hardening`",
	tags: ["process", "prioritization", "triage", "pipeline"],
	decides:
		"Every open issue must live in a milestone or be killed, except issues carrying one of exactly two standing-lane labels.",
	decision:
		"The 100%-homed rule has a standing-lane exemption for exactly two labels and nothing else inherits it. " +
		"A home-or-kill sweep treats an issue bearing either label as exempt and never force-fits a milestone onto it. " +
		"Every other open issue is milestone-homed or killed. " +
		"Banned: a third milestone-less category minted without a founder ruling.",
	context: "Extends the forward-motion doctrine in ADR [0202](0202-forward-motion-doctrine.md).",
});

const ADR_0202 = adr({
	id: "0202",
	title: "Forward-motion doctrine — p0 freely minted for arc-homed ship-work",
	tags: ["process", "prioritization", "pipeline"],
	decides:
		"Every unit of work is priced against whether it moves us forward, inside the documented active roadmap arc.",
	decision:
		"Kill or close is a valid triage verdict for improvement-for-improvement's-sake work. " +
		"Work with no forward-motion answer does not survive triage. " +
		"The documented roadmap, board and decision chain is the single company state agents reconcile toward.",
});

const ADR_0210 = adr({
	id: "0210",
	title: "Direction binds at intake — pitch, platform quota, appetite circuit-breaker",
	tags: ["governance", "roadmap", "pipeline"],
	decides:
		"The roadmap steers the factory when work is admitted, never by failing a finished pull request at merge time.",
	decision:
		"A pitch is required at triage before work enters the drain. " +
		"Work serving no active roadmap arc parks; it does not die. " +
		"Parked unpitched work auto-expires after three weeks and comes back with a pitch. " +
		"Explicitly rejected: any merge-blocking conformance gate on shipped work.",
	context: "Founder ruling recorded on the ADR [0078](0078-product-driven-decisions.md) path.",
});

describe("would-have-caught — the two live misses this tool exists for (#3980)", () => {
	const corpus = [ADR_0072, ADR_0202, ADR_0208, ADR_0210, ...filler(12)];
	const shortlistIds = (subject: {file: string; text: string}) => {
		const result = sweep({newAdr: subject, corpus});
		if (result.outcome._tag !== "shortlist")
			throw new Error(`expected shortlist, got ${result.outcome._tag}`);
		return result.outcome.candidates.map((c) => c.id);
	};

	it("instance 1 — ADR 0208 surfaces accepted ADR 0072, which it never cites", () => {
		expect(citedIds(ADR_0208.text).has("0072")).toBe(false);
		expect(shortlistIds(ADR_0208)).toContain("0072");
	});

	it("instance 2 — ADR 0210 surfaces accepted ADR 0202, which it never cites", () => {
		expect(citedIds(ADR_0210.text).has("0202")).toBe(false);
		expect(shortlistIds(ADR_0210)).toContain("0202");
	});

	it("does NOT surface a purely semantic conflict — the stated limit, asserted not hoped", () => {
		// The 0210-vs-0203 relocation shape: two ADRs that disagree about what a label MEANS while
		// sharing no distinctive vocabulary. This is the case a reviewer must still catch by reading.
		const semantic = adr({
			id: "0501",
			title: "Charting is the only doorway out of the holding lane",
			tags: ["frontend"],
			decides: "An entry in the holding lane departs when a cartographer charts it.",
			decision: "Charting alone releases an entry from the holding lane.",
		});
		const clock = adr({
			id: "0502",
			title: "A dormant bet retires after three weeks",
			tags: ["moderation"],
			decides: "A dormant bet retires automatically once three weeks elapse.",
			decision: "The scheduler retires a dormant bet; only a founder repitch revives it.",
		});
		const result = sweep({newAdr: clock, corpus: [clock, semantic, ...filler(10)]});
		const ids =
			result.outcome._tag === "shortlist" ? result.outcome.candidates.map((c) => c.id) : [];
		expect(ids).not.toContain("0501");
	});
});

describe("parseTags", () => {
	it("reads the bracketed tag row, lowercased; a missing row is no tags", () => {
		expect(parseTags(ADR_0072.text)).toEqual(["pipeline", "roadmap", "triage"]);
		expect(parseTags("---\nid: 1\n---\n")).toEqual([]);
	});
});
