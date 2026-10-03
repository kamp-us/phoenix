import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {classifyPark, KNOWN_PARKS} from "../recipe/parks.ts";
import {EPIC_RULES} from "../wire/lane-brief.ts";
import {MACHINERY_EVENT} from "./machine.ts";
import {REVIEW_UI_STATE} from "./prove.ts";
import {
	AXIS_ISSUE_CAUSES,
	axisIssueForCause,
	causeForEvent,
	conditionalTerminal,
	eventForToken,
	flattenVocabularies,
	MACHINERY_CAUSES,
	machineryCause,
	PARK_CAUSE_TOKENS,
	PARK_CAUSES,
	type ParkCause,
	PROOF_CONDITIONAL_TERMINALS,
	RETIRED_PARK_CAUSES,
	rationaleForEvent,
	remedyForCause,
	routeForCause,
	SHELL_VOCABULARIES,
	serviceAt,
	TERMINAL_PARK_CAUSES,
	tokenCause,
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

/**
 * Every park the rendered gate records: the three above, `ROUTED-ELSEWHERE`'s second cause for a
 * route the repo's `reviewUi.whenNoPreview` rules admitted, and `ESCALATED`, a verdict that provably
 * could not land. Under `parkCause.uncaused: "refuse"` an uncaused park is never recorded, so it
 * names its own cause too.
 */
const UI_REVIEWER_PARKS = [
	...RENDERED_PARKS,
	["CANT-SEE", "render-axis-missing"],
	["ROUTED-ELSEWHERE", "no-preview-routed"],
	["ESCALATED", "write-unlanded"],
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

	// The three builder terminals are indistinguishable here on purpose, and this is the line that
	// says so: nothing in this map can route an investigation past the review a `SHIPPED-PR` owes.
	// What tells them apart is `lane prove`'s answer, which the machine's `done:diagnosis` arm reads.
	it("maps all three of SHIPPED-PR, SUCCESS-NO-PR and BUILT-NO-PR to the one DONE", () => {
		expect(
			["SHIPPED-PR", "SUCCESS-NO-PR", "BUILT-NO-PR"].map((token) => eventForToken(token)),
		).toEqual([
			{_tag: "Mapped", token: "SHIPPED-PR", event: "DONE"},
			{_tag: "Mapped", token: "SUCCESS-NO-PR", event: "DONE"},
			{_tag: "Mapped", token: "BUILT-NO-PR", event: "DONE"},
		]);
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

describe("the states each vocabulary group serves", () => {
	it("refuses a builder's SHIPPED-PR out of ship, naming the token, the state and its owner", () => {
		const service = serviceAt("SHIPPED-PR", "ship");
		expect(service._tag).toBe("Unserved");
		if (service._tag !== "Unserved") return;
		expect(service.reason).toContain("SHIPPED-PR");
		expect(service.reason).toContain('"ship"');
		expect(service.reason).toContain("builder");
	});

	it("serves a builder's terminal out of either build state", () => {
		expect(serviceAt("SHIPPED-PR", "build")).toEqual({_tag: "Served", by: ["builder"]});
		expect(serviceAt("shipped-pr", "build:ui")).toEqual({_tag: "Served", by: ["builder"]});
	});

	it("serves the shipper's LANDED out of ship and the queue dwell", () => {
		expect(serviceAt("LANDED", "ship")).toEqual({_tag: "Served", by: ["shipper"]});
		expect(serviceAt("LANDED", "ship:queued")).toEqual({_tag: "Served", by: ["shipper"]});
	});

	it("accepts a shared token wherever any one of its owners serves the state", () => {
		expect(serviceAt("UNKNOWN", "review")).toEqual({_tag: "Served", by: ["reviewer"]});
		expect(serviceAt("UNKNOWN", "ship")).toEqual({_tag: "Served", by: ["shipper"]});
		expect(serviceAt("ESCALATED", "build")).toEqual({_tag: "Served", by: ["builder"]});
		expect(serviceAt("ESCALATED", "review:ui")).toEqual({_tag: "Served", by: ["ui-reviewer"]});
		expect(serviceAt("PASS", "review:ui")).toEqual({_tag: "Served", by: ["ui-reviewer"]});
		expect(serviceAt("FAIL", "integrate")).toEqual({_tag: "Served", by: ["integrator"]});
	});

	it("names every owner of a shared token when none serves the state", () => {
		const service = serviceAt("FAIL", "build");
		expect(service._tag).toBe("Unserved");
		if (service._tag !== "Unserved") return;
		for (const owner of ["reviewer", "ui-reviewer", "integrator"]) {
			expect(service.reason).toContain(owner);
		}
	});

	it("serves a machinery token out of any state", () => {
		for (const leaf of ["review", "review:ui", "ship", "ship:queued", "integrate", "queued"]) {
			expect(serviceAt("SHELL-DEAD", leaf)).toEqual({_tag: "Served", by: ["machinery"]});
		}
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
		// `ROUTED-ELSEWHERE`'s park is its floor, and the flat lookup still reads it — a caller that
		// asks the token alone gets the arm that has to be bought, never the one that advances a lane.
		expect(eventForToken("ROUTED-ELSEWHERE")).toMatchObject({event: "BLOCKED"});
	});

	// The emitting half: a cause the skill never tells the gate to pass is a cause nobody
	// names, so the rows would sit in code while every rendered park still landed bare.
	it.each(UI_REVIEWER_PARKS)("pairs %s with the --cause token %s", (token, cause) => {
		expect(section).toMatch(new RegExp(`${token}[\\s\\S]*?\`${cause}\``));
	});

	it("names those six causes and no seventh", () => {
		const named = PARK_CAUSE_TOKENS.filter((cause) => (section ?? "").includes(cause));

		expect(new Set(named)).toEqual(new Set(UI_REVIEWER_PARKS.map(([, cause]) => cause)));
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

	// A cause is payable on naming alone, and a row is bought separately. Two of the three have no
	// row and route to a human — naming the gap they routed on rather than the anonymous reason.
	it.each([
		["CANT-SEE", "no-preview-render"],
		["BLOCKED-NO-MANIFEST", "no-design-manifest"],
	] as const)("is Novel naming %2$s, not the anonymous reason", (_token, cause) => {
		const parked = classifyPark("blocked", cause);

		expect(parked._tag).toBe("Novel");
		if (parked._tag !== "Novel") return;
		expect(parked.reason).toContain(cause);
		expect(parked.reason).not.toContain("records the event and not its cause");
	});

	// The third bought its row: a route whose review has finished is a condition a recipe can read
	// back, which is what a row costs.
	it("is Known for no-rendered-delta, the one of the three with a proving read", () => {
		expect(classifyPark("blocked", "no-rendered-delta")._tag).toBe("Known");
	});
});

describe("a render-axis park names the issue it waits on", () => {
	it("requires --axis-issue beside render-axis-missing", () => {
		const resolved = axisIssueForCause(null, "render-axis-missing");

		expect(resolved._tag).toBe("Rejected");
		expect(resolved._tag === "Rejected" && resolved.reason).toMatch(/--axis-issue/);
	});

	it("seats the issue beside render-axis-missing", () => {
		expect(axisIssueForCause(9615, "render-axis-missing")).toEqual({
			_tag: "Named",
			axisIssue: 9615,
		});
	});

	it.each([
		["no-preview-render", 9615],
		[null, 9615],
	] as const)("refuses --axis-issue beside %p", (cause, issue) => {
		expect(axisIssueForCause(issue, cause)._tag).toBe("Rejected");
	});

	it.each([0, -3, 1.5])("refuses %p as no issue number", (issue) => {
		expect(axisIssueForCause(issue, "render-axis-missing")._tag).toBe("Rejected");
	});

	it("leaves every other cause without one exactly as it was", () => {
		expect(axisIssueForCause(null, "no-preview-render")).toEqual({_tag: "Named", axisIssue: null});
		expect(axisIssueForCause(null, null)).toEqual({_tag: "Named", axisIssue: null});
	});

	it("keys only the render-axis cause on an issue", () => {
		expect([...AXIS_ISSUE_CAUSES]).toEqual(["render-axis-missing"]);
		expect(PARK_CAUSE_TOKENS).toContain("render-axis-missing");
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
		expect(PARK_CAUSE_TOKENS).toHaveLength(
			Object.keys(PARK_CAUSES).length - RETIRED_PARK_CAUSES.size,
		);
	});

	it("routes campaign-paused to the founder — a campaign's lifecycle is a product call", () => {
		expect(routeForCause("campaign-paused")).toBe("founder");
	});

	it.each([
		"worktree-holds-branch",
		"head-behind-base",
		"spawn-dead",
		"no-preview-render",
		"render-axis-missing",
		"no-design-manifest",
		"no-rendered-delta",
		"write-unlanded",
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

	// The replay's own refusal is the same judgment from the other side — one child's range against
	// another's rather than the trunk's — so it routes to the driver and names no verb either.
	it("names no verb for replay-conflict, and routes it to the driver", () => {
		expect(remedyForCause("replay-conflict")).toBeNull();
		expect(routeForCause("replay-conflict")).toBe("driver");
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
		expect(causeForEvent("worktree-holds-branch", "BLOCKED", requireCause)).toEqual({
			_tag: "Caused",
			cause: "worktree-holds-branch",
		});
	});

	it("refuses a retired cause as a new park, while it still routes on an earlier line", () => {
		expect(causeForEvent("campaign-paused", "BLOCKED", false)).toMatchObject({
			_tag: "Rejected",
			reason: expect.stringContaining('"campaign-paused" is a retired park cause'),
		});
		expect(PARK_CAUSE_TOKENS).not.toContain("campaign-paused");
		expect(routeForCause("campaign-paused")).toBe("founder");
	});
});

describe("the rationale a clearance rides on", () => {
	it("carries nothing when nothing was named — the ordinary resume, unchanged", () => {
		expect(rationaleForEvent(null, "UNBLOCKED")).toEqual({_tag: "Reasoned", rationale: null});
	});

	it("seats a named rationale on the resume, trimmed", () => {
		expect(rationaleForEvent("  the head was rebased  ", "UNBLOCKED")).toEqual({
			_tag: "Reasoned",
			rationale: "the head was rebased",
		});
	});

	// A recorded reason nobody can read is the unauditable clearance the field exists to prevent, so
	// it is refused rather than folded into "no rationale".
	it("rejects a blank one rather than reading it as none", () => {
		const resolved = rationaleForEvent("   ", "UNBLOCKED");

		expect(resolved._tag).toBe("Rejected");
	});

	it.each([
		"DONE",
		"PASS",
		"FAIL",
		"WIP",
		"BLOCKED",
	] as const)("rejects one riding %s, which clears no park", (event) => {
		const resolved = rationaleForEvent("a reason", event);

		expect(resolved._tag).toBe("Rejected");
		if (resolved._tag !== "Rejected") return;
		expect(resolved.reason).toContain("UNBLOCKED");
	});
});

describe("the machinery terminals a driver records about the pipeline itself", () => {
	it.each(
		Object.entries(MACHINERY_CAUSES),
	)("%s records the machine's machinery event, not a content FAIL", (token) => {
		expect(eventForToken(token)).toMatchObject({token, event: MACHINERY_EVENT});
	});

	it.each(Object.entries(MACHINERY_CAUSES))("%s names %s off the routed table", (token, cause) => {
		expect(machineryCause(token)).toBe(cause);
		expect(PARK_CAUSE_TOKENS).toContain(cause);
	});

	it("reads a token's cause case-insensitively, the way its event is read", () => {
		expect(machineryCause("replay-collided")).toBe("replay-conflict");
		expect(machineryCause(" Base-Drifted ")).toBe("head-behind-base");
	});

	it("names no cause for a token outside the group", () => {
		for (const token of ["PASS", "FAIL", "EJECTED", "SHIPPED-PR"]) {
			expect(machineryCause(token)).toBeNull();
		}
	});

	it("tells an integrate-sourced failure from a review-sourced one at the event", () => {
		const integrate = eventForToken("REPLAY-COLLIDED");
		const review = eventForToken("FAIL");

		expect(integrate).toMatchObject({event: MACHINERY_EVENT});
		expect(review).toMatchObject({event: "FAIL"});
		expect(integrate).not.toMatchObject({event: "FAIL"});
	});
});

describe("the park terminals whose token names their own cause", () => {
	it.each(Object.entries(TERMINAL_PARK_CAUSES))("%s parks, and names %s", (token, cause) => {
		expect(eventForToken(token)).toMatchObject({event: "BLOCKED"});
		expect(tokenCause(token)).toBe(cause);
		expect(PARK_CAUSE_TOKENS).toContain(cause);
	});

	it("reads the machinery table through the same lookup", () => {
		expect(tokenCause(" base-drifted ")).toBe("head-behind-base");
	});

	// `ship`'s other parks fold to `human:cp-approval` for other reasons, so none may inherit a
	// token's cause and match a recipe row keyed on it.
	it("names no cause for a ship park whose token has more than one reason", () => {
		for (const token of ["REFUSED", "UNKNOWN", "ROUTED-HEAL-CI"]) {
			expect(tokenCause(token)).toBeNull();
		}
	});

	it("routes a verdict owed at the head to the driver and names no remedy", () => {
		expect(tokenCause("ROUTED-REVIEW")).toBe("verdict-owed");
		expect(routeForCause("verdict-owed")).toBe("driver");
		expect(remedyForCause("verdict-owed")).toBeNull();
	});

	it("routes the approval wait to the founder and names no remedy", () => {
		expect(routeForCause("awaiting-cp-approval")).toBe("founder");
		expect(remedyForCause("awaiting-cp-approval")).toBeNull();
	});
});

describe("a machinery lap's cause", () => {
	it("is Required under every park-cause rule — a lap that names no machinery says nothing", () => {
		for (const requireCause of [false, true]) {
			const resolved = causeForEvent(null, MACHINERY_EVENT, requireCause);

			expect(resolved._tag).toBe("Required");
			if (resolved._tag !== "Required") continue;
			for (const cause of PARK_CAUSE_TOKENS) expect(resolved.reason).toContain(cause);
		}
	});

	it("takes any cause the routed table carries, so a recorder that knows better may say so", () => {
		expect(causeForEvent("assembly-conflict", MACHINERY_EVENT, false)).toEqual({
			_tag: "Caused",
			cause: "assembly-conflict",
		});
	});

	it("refuses a cause the routed table does not carry", () => {
		expect(causeForEvent("something-went-wrong", MACHINERY_EVENT, false)).toMatchObject({
			_tag: "Rejected",
		});
	});
});

/**
 * The one token that names two events. Its key is the token AND the leaf, and the leaf half is what
 * keeps the widening narrow — a `PASS` out of any other cell walks a different arm, and an epic
 * child's region holds no `review:ui` cell at all, so that deferral is untouched by construction.
 */
describe("the terminal whose event a proof picks", () => {
	it("reads ROUTED-ELSEWHERE out of review:ui as a PASS the proof may earn", () => {
		expect(conditionalTerminal("ROUTED-ELSEWHERE", REVIEW_UI_STATE)).toMatchObject({
			advanced: "PASS",
			parked: "BLOCKED",
		});
	});

	it("folds the token's spelling, exactly as the flat lookup does", () => {
		expect(conditionalTerminal("routed-elsewhere", REVIEW_UI_STATE)).not.toBeNull();
	});

	it("is null out of every other cell, so the flat reading stands there", () => {
		expect(conditionalTerminal("ROUTED-ELSEWHERE", "review")).toBeNull();
		expect(conditionalTerminal("ROUTED-ELSEWHERE", "ship")).toBeNull();
		expect(conditionalTerminal("ROUTED-ELSEWHERE", "blocked")).toBeNull();
	});

	it("is null for every other terminal, at that cell and anywhere else", () => {
		expect(conditionalTerminal("CANT-SEE", REVIEW_UI_STATE)).toBeNull();
		expect(conditionalTerminal("BLOCKED-NO-MANIFEST", REVIEW_UI_STATE)).toBeNull();
		expect(conditionalTerminal("FAIL", REVIEW_UI_STATE)).toBeNull();
	});

	// Written twice — once flat, once as the row's fallback — so it is checked rather than trusted.
	it("parks on the same event the flat lookup maps the token to", () => {
		for (const [token, row] of Object.entries(PROOF_CONDITIONAL_TERMINALS)) {
			expect(eventForToken(token)).toMatchObject({event: row.parked});
		}
	});
});
