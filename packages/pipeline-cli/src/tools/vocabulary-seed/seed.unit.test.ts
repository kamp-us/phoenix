/**
 * Pure-core tests for `vocabulary-seed` (#4341): the seed set comes from the one create-ready home
 * and totally covers what the preflight enforces, the diff creates only what is missing, a 422 is
 * read for what it actually says, and the ROADMAP scaffold parses under the roadmap parser the
 * preflight itself uses. No IO — `gh` and disk are crossed in `gate.behavior.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {parseRoadmap} from "../roadmap-guard/roadmap-guard.ts";
import {
	LABEL_SPECS,
	REQUIRED_LABELS,
	SPECIFIED_LABELS,
	unspecifiedRequiredLabels,
} from "../vocabulary-preflight/vocabulary.ts";
import {
	isAlreadyExists,
	planLabels,
	ROADMAP_SCAFFOLD,
	renderPlan,
	renderResult,
	seedPrecondition,
} from "./seed.ts";

describe("the seed set is the preflight's set, not a fourth list", () => {
	it("covers every label `vocabulary-preflight check` enforces", () => {
		for (const label of REQUIRED_LABELS) expect(SPECIFIED_LABELS).toContain(label);
		expect(unspecifiedRequiredLabels()).toEqual([]);
	});

	it("clears its own precondition — a gap here would seed a taxonomy that stays red", () => {
		expect(seedPrecondition()).toBeNull();
	});

	it("gives every row the two fields a create needs, and no `|` to break the bash seam", () => {
		for (const spec of LABEL_SPECS) {
			expect(spec.color).toMatch(/^[0-9a-f]{6}$/);
			expect(spec.description.length).toBeGreaterThan(0);
			expect(spec.description).not.toContain("|");
			expect(spec.name).not.toContain("|");
		}
	});

	it("names each label once — a duplicate row would create then 422 against itself", () => {
		expect(new Set(SPECIFIED_LABELS).size).toBe(SPECIFIED_LABELS.length);
	});
});

describe("planLabels", () => {
	it("creates everything against a bare repo — the from-zero adopter this exists for", () => {
		const {create, present} = planLabels(LABEL_SPECS, []);
		expect(create).toEqual([...LABEL_SPECS]);
		expect(present).toEqual([]);
	});

	it("creates ONLY what is missing against a partially-seeded repo (idempotency, the diff half)", () => {
		const already = SPECIFIED_LABELS.slice(0, 3);
		const {create, present} = planLabels(LABEL_SPECS, already);
		expect(present).toEqual(already);
		expect(create.map((s) => s.name)).toEqual(SPECIFIED_LABELS.slice(3));
	});

	it("creates nothing on a re-run against a fully-seeded repo", () => {
		const {create, present} = planLabels(LABEL_SPECS, [...SPECIFIED_LABELS, "unrelated"]);
		expect(create).toEqual([]);
		expect(present).toEqual([...SPECIFIED_LABELS]);
	});
});

describe("isAlreadyExists — the 422 that is a success vs the 422 that is a defect", () => {
	it("reads GitHub's already_exists code out of the error body gh prints to stdout", () => {
		const body = JSON.stringify({
			message: "Validation Failed",
			errors: [{resource: "Label", code: "already_exists", field: "name"}],
		});
		expect(isAlreadyExists(`${body}\ngh: Validation Failed (HTTP 422)`)).toBe(true);
	});

	it("does NOT read a malformed-colour 422 as already-existing", () => {
		const body = JSON.stringify({
			message: "Validation Failed",
			errors: [{resource: "Label", code: "invalid", field: "color"}],
		});
		expect(isAlreadyExists(`${body}\ngh: Validation Failed (HTTP 422)`)).toBe(false);
	});

	it("does not read an auth or not-found failure as already-existing", () => {
		expect(isAlreadyExists("gh: Not Found (HTTP 404)")).toBe(false);
		expect(isAlreadyExists("gh: Bad credentials (HTTP 401)")).toBe(false);
	});
});

describe("ROADMAP_SCAFFOLD", () => {
	it("parses at least one arc row — the seeded repo clears the roadmap prerequisite", () => {
		const {arcs} = parseRoadmap(ROADMAP_SCAFFOLD);
		expect(arcs.length).toBeGreaterThan(0);
	});

	it("ships that arc QUEUED and unpinned, the legal shape for an arc with no milestone yet", () => {
		const [arc] = parseRoadmap(ROADMAP_SCAFFOLD).arcs;
		expect(arc?.state).toBe("queued");
		expect(arc?.milestone).toBeNull();
	});

	it("parses no campaign rows — the table is a header a maintainer fills, not a fixture", () => {
		expect(parseRoadmap(ROADMAP_SCAFFOLD).campaigns).toEqual([]);
	});

	// The ADR-0072 disposition has to survive in the artifact, not only in the PR that added it:
	// the seeded file is the only thing an adopter reads.
	it("says in the file itself that a human creates the milestones", () => {
		expect(ROADMAP_SCAFFOLD).toContain("creates no milestones");
		expect(ROADMAP_SCAFFOLD).toContain("human roadmap decision");
	});

	it("carries no absolute, home, or sibling-repo path — it is written into someone else's repo", () => {
		expect(ROADMAP_SCAFFOLD).not.toMatch(/(^|\s)[~/][A-Za-z~/]/);
	});
});

describe("the rendered output", () => {
	it("says out loud that a plan wrote nothing", () => {
		const report = renderPlan({
			repo: "owner/name",
			create: [...LABEL_SPECS],
			present: [],
			roadmap: {_tag: "create", path: "/repo/ROADMAP.md"},
		});
		expect(report).toContain("nothing has been written");
		expect(report).toContain("owner/name");
	});

	it("names the resolved repo and the milestone carve-out in the apply result", () => {
		const report = renderResult("owner/name", [{name: "p0", outcome: "created"}], {
			_tag: "keep",
			path: "/repo/ROADMAP.md",
		});
		expect(report).toContain("owner/name");
		expect(report).toContain("labels created: 1");
		expect(report).toContain("NOT seeded, by design: GitHub milestones");
	});
});
