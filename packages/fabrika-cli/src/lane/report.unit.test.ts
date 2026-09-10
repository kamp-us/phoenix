import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {classifyPark, KNOWN_PARKS} from "../recipe/parks.ts";
import {EPIC_RULES} from "../wire/lane-brief.ts";
import {
	causeForEvent,
	eventForToken,
	flattenVocabularies,
	PARK_CAUSE_TOKENS,
	PARK_CAUSES,
	type ParkCause,
	remedyForCause,
	routeForCause,
	SHELL_VOCABULARIES,
} from "./report.ts";

/**
 * The rendered gate's three no-verdict terminals and the park cause each one reports with.
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

describe("the shipper's two queue terminals are waits, not landings", () => {
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
	// unrenderable lane's report hit the refusal and the lane stayed `active` forever.
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

	// The emitting half: a cause the skill never tells the gate to pass is a cause nobody
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

describe("the rendered gate's three parks name a cause instead of landing bare", () => {
	it.each(RENDERED_PARKS)("takes %s's cause on the BLOCKED it maps to", (token, cause) => {
		const resolved = eventForToken(token);
		if (resolved._tag !== "Mapped") throw new Error(resolved.reason);

		expect(resolved.event).toBe("BLOCKED");
		expect(causeForEvent(cause, resolved.event, false)).toEqual({_tag: "Caused", cause});
	});

	it.each(RENDERED_PARKS)("refuses %2$s on an event that is not a park", (_token, cause) => {
		expect(causeForEvent(cause, "PASS", false)).toMatchObject({_tag: "Rejected"});
		expect(causeForEvent(cause, "DONE", false)).toMatchObject({_tag: "Rejected"});
	});

	// A cause is payable on naming alone. No `KNOWN_PARKS` row covers any of the three, so
	// the sweep still routes them to a human — it now says which gap it routed on.
	it.each(RENDERED_PARKS)("is Novel naming %2$s, not the anonymous reason", (_token, cause) => {
		const parked = classifyPark("blocked", cause);

		expect(parked._tag).toBe("Novel");
		if (parked._tag !== "Novel") return;
		expect(parked.reason).toContain(cause);
		expect(parked.reason).not.toContain("records the event and not its cause");
	});
});

/**
 * The route axis: every cause carries one, both `KNOWN_PARKS` shapes read it off this one table, and
 * a cause added without a route reds here rather than routing silently.
 */
describe("every park cause carries a route", () => {
	it.each(PARK_CAUSE_TOKENS)("%s carries a route of driver or founder", (cause) => {
		const entry = PARK_CAUSES[cause as ParkCause];

		expect(entry).toBeDefined();
		expect(["driver", "founder"]).toContain(entry.route);
	});

	// The `retry-budget.unit.test.ts` shape, for the same reason: nothing destructures `route` at a
	// site TypeScript would red, so the drift guard has to read the table itself.
	it("leaves no token routeless — a new cause added without a route reds here", () => {
		const routeless = Object.entries(PARK_CAUSES).filter(
			([, entry]) => entry.route !== "driver" && entry.route !== "founder",
		);

		expect(routeless).toEqual([]);
		expect(PARK_CAUSE_TOKENS).toHaveLength(Object.keys(PARK_CAUSES).length);
	});

	it("routes campaign-paused to the founder — a campaign's lifecycle is a product call", () => {
		expect(routeForCause("campaign-paused")).toBe("founder");
	});

	it.each([
		"worktree-holds-branch",
		"head-behind-base",
		"spawn-dead",
		"no-preview-render",
		"no-design-manifest",
		"no-rendered-delta",
	])("routes %s to the driver — it is machinery, and no product call is in it", (cause) => {
		expect(routeForCause(cause)).toBe("driver");
	});

	// Fail-closed: a park nothing named cannot be attributed to machinery, so the derivation may not
	// claim a driver can work it.
	it.each([null, "not-a-cause"])("routes an unnamed park (%p) to the founder", (cause) => {
		expect(routeForCause(cause)).toBe("founder");
	});

	it("carries the route onto every KNOWN_PARKS row, read off the same table", () => {
		expect(KNOWN_PARKS).not.toHaveLength(0);
		for (const recipe of KNOWN_PARKS) {
			expect(recipe.route).toBe(routeForCause(recipe.cause));
		}
	});
});

describe("remedyForCause", () => {
	// The four-year-old "clearing it needs a verb that merges the base into the head, and `build`
	// ships none" is what `lane refresh` retires. The cause is where that verb is written down.
	it("names lane refresh for head-behind-base, which is the verb that moves a head onto its base", () => {
		expect(remedyForCause("head-behind-base")).toBe("fabrika lane refresh");
	});

	it("names no verb for assembly-conflict — resolving content is a judgment none may make", () => {
		expect(remedyForCause("assembly-conflict")).toBeNull();
	});

	it.each([null, "not-a-cause"])("has no remedy for an unnamed park (%p)", (cause) => {
		expect(remedyForCause(cause)).toBeNull();
	});

	it("carries the remedy onto every KNOWN_PARKS row, read off the same table", () => {
		expect(KNOWN_PARKS).not.toHaveLength(0);
		for (const recipe of KNOWN_PARKS) {
			expect(recipe.remedy).toBe(remedyForCause(recipe.cause));
		}
	});
});

describe("a BLOCKED that names no cause", () => {
	it("records as the bare park it always was while the key is off", () => {
		expect(causeForEvent(null, "BLOCKED", false)).toEqual({_tag: "Uncaused"});
	});

	it("is Required — never Rejected — while the key is on, so its own exit code is reachable", () => {
		const resolved = causeForEvent(null, "BLOCKED", true);

		expect(resolved._tag).toBe("Required");
		if (resolved._tag !== "Required") return;
		// The refusal is actionable on its own line: a caller reading only stderr must not have to go
		// find the closed set somewhere else.
		for (const cause of PARK_CAUSE_TOKENS) expect(resolved.reason).toContain(cause);
	});

	it.each([
		"DONE",
		"PASS",
		"FAIL",
		"WIP",
		"UNBLOCKED",
	] as const)("is untouched on %s, which is no park — the key binds BLOCKED alone", (event) => {
		expect(causeForEvent(null, event, true)).toEqual({_tag: "Uncaused"});
	});

	it.each([false, true])("leaves a named cause alone at requireCause %p", (requireCause) => {
		expect(causeForEvent("campaign-paused", "BLOCKED", requireCause)).toEqual({
			_tag: "Caused",
			cause: "campaign-paused",
		});
	});
});
