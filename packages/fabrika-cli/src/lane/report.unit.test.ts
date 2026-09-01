import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {classifyPark} from "../recipe/parks.ts";
import {EPIC_RULES} from "../wire/lane-brief.ts";
import {
	causeForEvent,
	eventForToken,
	flattenVocabularies,
	PARK_CAUSE_TOKENS,
	SHELL_VOCABULARIES,
} from "./report.ts";

/**
 * The rendered gate's three no-verdict terminals and the park cause each one reports with (#7423).
 * Every one folds to `BLOCKED`, and until these causes existed none could name why — so a rendered
 * park read as the bare-`BLOCKED` Novel and cost a human `UNBLOCKED` by construction.
 */
const RENDERED_PARKS = [
	["CANT-SEE", "no-preview-render"],
	["BLOCKED-NO-MANIFEST", "no-design-manifest"],
	["ROUTED-ELSEWHERE", "no-rendered-delta"],
] as const;

describe("the builder's no-PR terminals", () => {
	it("routes an epic child's BUILT-NO-PR to DONE, not to the BLOCKED a clean build never earned", () => {
		expect(eventForToken("BUILT-NO-PR")).toEqual({
			_tag: "Mapped",
			token: "BUILT-NO-PR",
			event: "DONE",
		});
	});

	it("keeps SUCCESS-NO-PR its own token — the child terminal is additive, not a widening", () => {
		expect(SHELL_VOCABULARIES.builder).toMatchObject({
			"SUCCESS-NO-PR": "DONE",
			"BUILT-NO-PR": "DONE",
		});
	});

	it("recognises the terminal the epic-run brief tells a child to end on", () => {
		const named = /ends on `([A-Z][A-Z-]+)`/.exec(EPIC_RULES);
		expect(named?.[1]).toBe("BUILT-NO-PR");
		expect(eventForToken(named?.[1] ?? "")).toMatchObject({event: "DONE"});
	});
});

describe("the shipper's routing arms are three answers, not one", () => {
	it("routes the repair arm to FAIL so the ship state spends a retry back into build", () => {
		expect(eventForToken("ROUTED-REPAIR")).toEqual({
			_tag: "Mapped",
			token: "ROUTED-REPAIR",
			event: "FAIL",
		});
		expect(eventForToken("EJECTED")).toEqual({_tag: "Mapped", token: "EJECTED", event: "FAIL"});
	});

	it("leaves the heal-ci and review arms BLOCKED — neither is work this lane can retry", () => {
		expect(eventForToken("ROUTED-HEAL-CI")).toMatchObject({event: "BLOCKED"});
		expect(eventForToken("ROUTED-REVIEW")).toMatchObject({event: "BLOCKED"});
	});

	it("no longer recognises a bare ROUTED as the shipper's — the reviewer's is what it resolves to", () => {
		expect(SHELL_VOCABULARIES.shipper).not.toHaveProperty("ROUTED");
		expect(eventForToken("ROUTED")).toEqual({_tag: "Mapped", token: "ROUTED", event: "BLOCKED"});
	});
});

describe("the shipper's two queue terminals are waits, not landings (ADR 0313)", () => {
	it("routes a still-queued-at-horizon shipper to WIP, so the lane waits instead of parking", () => {
		expect(eventForToken("UNRESOLVED")).toEqual({
			_tag: "Mapped",
			token: "UNRESOLVED",
			event: "WIP",
		});
	});

	it("routes a bare enqueue to WIP too — a merge nobody read back is not `shipped`", () => {
		expect(eventForToken("QUEUED")).toEqual({_tag: "Mapped", token: "QUEUED", event: "WIP"});
	});

	it("keeps DONE for the two terminals that read a merge back", () => {
		expect(eventForToken("LANDED")).toMatchObject({event: "DONE"});
		expect(eventForToken("ALREADY-MERGED")).toMatchObject({event: "DONE"});
	});

	it("still folds every genuine shipper block to BLOCKED", () => {
		expect(eventForToken("REFUSED")).toMatchObject({event: "BLOCKED"});
		expect(eventForToken("AWAITING-CP-APPROVAL")).toMatchObject({event: "BLOCKED"});
		expect(eventForToken("UNKNOWN")).toMatchObject({event: "BLOCKED"});
	});
});

describe("flattening the per-shell vocabularies", () => {
	it("flattens the real vocabularies with nothing overwritten", () => {
		const flat = flattenVocabularies(SHELL_VOCABULARIES);
		expect(flat).toMatchObject({_tag: "Flat"});
	});

	it("keeps a token two shells spell the same way when they agree on the event", () => {
		const flat = flattenVocabularies({
			reviewer: {UNKNOWN: "BLOCKED"},
			shipper: {UNKNOWN: "BLOCKED"},
		});
		expect(flat).toEqual({_tag: "Flat", tokens: {UNKNOWN: "BLOCKED"}});
	});

	it("names a token two shells spell the same way with different events, both sides in the reason", () => {
		const flat = flattenVocabularies({
			reviewer: {ROUTED: "BLOCKED"},
			shipper: {ROUTED: "FAIL"},
		});
		expect(flat._tag).toBe("Collision");
		if (flat._tag !== "Collision") return;
		expect(flat.collisions).toEqual(["ROUTED: reviewer reports BLOCKED, shipper reports FAIL"]);
	});

	it("catches the collision whichever shell is written last", () => {
		const flat = flattenVocabularies({
			shipper: {ROUTED: "FAIL"},
			reviewer: {ROUTED: "BLOCKED"},
		});
		expect(flat).toMatchObject({
			_tag: "Collision",
			collisions: ["ROUTED: shipper reports FAIL, reviewer reports BLOCKED"],
		});
	});
});

describe("the UI reviewer's vocabulary against the skill that owns it", () => {
	// Parsing the skill rather than restating it is what makes a seventh terminal fail here instead
	// of stranding the next lane that ends on it — three of these six named no event at all, so an
	// unrenderable lane's report hit the refusal and the lane stayed `active` forever (#7403).
	const SKILL = fileURLToPath(
		new URL("../../../../claude-plugins/fabrika/skills/review-ui/SKILL.md", import.meta.url),
	);
	const section = /\n## Terminal vocabulary\n([\s\S]*?)(?=\n## )/.exec(
		readFileSync(SKILL, "utf8"),
	)?.[1];
	const declared = [...(section ?? "").matchAll(/\*\*(?:verdict )?([A-Z][A-Z-]+)\*\*/g)].flatMap(
		(match) => (match[1] === undefined ? [] : [match[1]]),
	);

	it("reads the section and the six terminals it names", () => {
		expect(section).toBeDefined();
		expect(new Set(declared)).toEqual(
			new Set(["PASS", "FAIL", "CANT-SEE", "ESCALATED", "BLOCKED-NO-MANIFEST", "ROUTED-ELSEWHERE"]),
		);
	});

	it("resolves every terminal the skill declares, none to the refusal", () => {
		for (const token of declared) {
			expect(eventForToken(token)).toMatchObject({_tag: "Mapped", token});
		}
	});

	it("holds exactly those terminals in the ui-reviewer group", () => {
		expect(new Set(Object.keys(SHELL_VOCABULARIES["ui-reviewer"]))).toEqual(new Set(declared));
	});

	it("parks the three terminals that land no verdict and owe a human something", () => {
		expect(eventForToken("CANT-SEE")).toEqual({
			_tag: "Mapped",
			token: "CANT-SEE",
			event: "BLOCKED",
		});
		expect(eventForToken("BLOCKED-NO-MANIFEST")).toMatchObject({event: "BLOCKED"});
		expect(eventForToken("ROUTED-ELSEWHERE")).toMatchObject({event: "BLOCKED"});
	});

	// The emitting half of #7423: a cause the skill never tells the gate to pass is a cause nobody
	// names, so the rows would sit in code while every rendered park still landed bare.
	it.each(RENDERED_PARKS)("pairs %s with the --cause token %s", (token, cause) => {
		expect(section).toMatch(new RegExp(`${token}[\\s\\S]*?\`${cause}\``));
	});

	// The fourth park terminal, `ESCALATED`, is deliberately uncaused: the builder and reviewer
	// groups spell it the same way, so seating a cause for it is a cross-shell change.
	it("names those three causes and no fourth", () => {
		const named = PARK_CAUSE_TOKENS.filter((cause) => (section ?? "").includes(cause));

		expect(new Set(named)).toEqual(new Set(RENDERED_PARKS.map(([, cause]) => cause)));
	});
});

describe("the rendered gate's three parks name a cause instead of landing bare (#7423)", () => {
	it.each(RENDERED_PARKS)("takes %s's cause on the BLOCKED it maps to", (token, cause) => {
		const resolved = eventForToken(token);
		if (resolved._tag !== "Mapped") throw new Error(resolved.reason);

		expect(resolved.event).toBe("BLOCKED");
		expect(causeForEvent(cause, resolved.event)).toEqual({_tag: "Caused", cause});
	});

	it.each(RENDERED_PARKS)("refuses %2$s on an event that is not a park", (_token, cause) => {
		expect(causeForEvent(cause, "PASS")).toMatchObject({_tag: "Rejected"});
		expect(causeForEvent(cause, "DONE")).toMatchObject({_tag: "Rejected"});
	});

	// ADR 0339: a cause is payable on naming alone. No `KNOWN_PARKS` row covers any of the three, so
	// the sweep still routes them to a human — it now says which gap it routed on.
	it.each(RENDERED_PARKS)("is Novel naming %2$s, not the anonymous reason", (_token, cause) => {
		const parked = classifyPark("blocked", cause);

		expect(parked._tag).toBe("Novel");
		if (parked._tag !== "Novel") return;
		expect(parked.reason).toContain(cause);
		expect(parked.reason).not.toContain("records the event and not its cause");
	});
});
