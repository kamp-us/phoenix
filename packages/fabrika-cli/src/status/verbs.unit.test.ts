/**
 * The in-process half: every verb's outcome — its code, its stdout bytes and the state words it
 * keeps apart — driven over scripted reads rather than a real filesystem or a real GitHub.
 *
 * The property under test throughout is the three-state law: a proven negative is an exit-`0` token,
 * an unread source is `unknown`, and the two never collapse.
 */
import {describe, expect, it} from "vitest";
import * as report from "../report/codes.ts";
import {ANSWER} from "../verb.ts";
import {type BoardRead, type Bucket, boardState, runBoard} from "./board-verb.ts";
import {
	BUILDABLE_SURFACES,
	findSurface,
	ISSUE_SHAPE_MARKERS,
	knownIds,
	MARKER_COLOR,
	TAXONOMY,
} from "./bootstrap-verb.ts";
import {NOT_BUILDABLE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {configState, countsOf, runConfig, type SurfaceRow} from "./config-verb.ts";
import {noAsOf, oneLine, readNow} from "./fields.ts";
import {runMenu} from "./menu-verb.ts";
import {
	badFieldRefusal,
	boardField,
	configField,
	menuField,
	readoutField,
	runOpen,
} from "./open-verb.ts";
import {digestComment, issueNumberOf, runReadout} from "./readout-verb.ts";
import {parseFrontmatter, type RosterRead, type RosterSkill, skillFrom} from "./roster.ts";

const AS_OF = readNow("2026-08-09T14:22:03Z");

const skill = (name: string, text: string): RosterSkill => skillFrom(name, text);

const resolvedRoster = (skills: ReadonlyArray<RosterSkill>): RosterRead => ({
	_tag: "Resolved",
	path: "/abs/claude-plugins/fabrika/skills",
	display: "claude-plugins/fabrika/skills",
	tier: "repo",
	skills,
	unreadableFrontmatter: skills.filter((s) => !s.frontmatterReadable).length,
});

const surface = (over: Partial<SurfaceRow>): SurfaceRow => ({
	skill: "build",
	surfaceId: "-",
	disposition: "degrade",
	presence: "present",
	consequence: "-",
	detail: "ROADMAP.md",
	asOf: AS_OF,
	...over,
});

describe("the roster row", () => {
	it("reads the frontmatter's description and the invocation axis", () => {
		const row = skill(
			"front-door",
			"---\nname: front-door\ndisable-model-invocation: true\ndescription: The front door.\n---\n",
		);
		expect(row.invocation).toBe("/fabrika:front-door");
		expect(row.invocationAxis).toBe("user");
		expect(row.description).toBe("The front door.");
	});

	it("defaults the axis to model when the flag is absent", () => {
		expect(skill("build", "---\nname: build\ndescription: d\n---\n").invocationAxis).toBe("model");
	});

	/** A dropped row is a skill the reader will never know exists — the false absence of #4105. */
	it("emits a row saying so when the frontmatter cannot be parsed, rather than dropping it", () => {
		const row = skill("broken", "# no frontmatter at all\n");
		expect(parseFrontmatter("# no frontmatter at all\n")).toBeNull();
		expect(row.description).toBe("unknown (frontmatter unreadable)");
		expect(row.frontmatterReadable).toBe(false);
	});
});

describe("status menu", () => {
	it("renders a resolved roster at exit 0, one line per skill", () => {
		const out = runMenu({
			roster: resolvedRoster([skill("build", "---\nname: build\ndescription: d\n---\n")]),
			asOf: AS_OF,
			json: false,
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe(
			"menu\tready\t1\t2026-08-09T14:22:03Z\nskill\tbuild\t/fabrika:build\tmodel\td\n",
		);
	});

	/** An implicitly-resolved roster holding zero skills is a FACT, not a refusal. */
	it("renders an empty roster as `empty` at exit 0, never silence", () => {
		const out = runMenu({roster: resolvedRoster([]), asOf: AS_OF, json: false});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("menu\tempty\t0\t2026-08-09T14:22:03Z\n");
	});

	it("seats an explicitly-passed absent path on 7 and an unreadable roster on 11 — never one code", () => {
		const seven = runMenu({
			roster: {_tag: "AbsentExplicit", path: "/nope", display: "/nope"},
			asOf: AS_OF,
			json: false,
		});
		const eleven = runMenu({
			roster: {_tag: "Failed", path: "/x", display: "x", reason: "EACCES"},
			asOf: AS_OF,
			json: false,
		});
		expect(seven.code).toBe(ZERO_SCOPE);
		expect(eleven.code).toBe(PRECONDITION_UNKNOWN);
		expect(seven.code).not.toBe(eleven.code);
		expect(seven.stdout).toBe("");
		expect(eleven.stdout).toBe("");
	});
});

describe("status config", () => {
	it("is `gaps`, never `satisfied`, over a roster that holds zero skills", () => {
		expect(configState([], 0)).toBe("gaps");
	});

	it("is `satisfied` only when every declared surface is proven present", () => {
		expect(configState([surface({})], 1)).toBe("satisfied");
		expect(configState([surface({presence: "unprobeable"})], 1)).toBe("gaps");
		expect(configState([surface({presence: "unknown"})], 1)).toBe("gaps");
		expect(configState([surface({disposition: "undeclared", presence: "unknown"})], 1)).toBe(
			"gaps",
		);
	});

	it("deduplicates the missing count by id while every declaring row still prints", () => {
		const counts = countsOf([
			surface({skill: "build", surfaceId: "taxonomy", presence: "missing"}),
			surface({skill: "operate", surfaceId: "taxonomy", presence: "missing"}),
			surface({skill: "review", surfaceId: "other", presence: "missing"}),
		]);
		expect(counts.missing).toBe(2);
		expect(counts.declaredSkills).toBe(3);
	});

	it("counts a disposition off the canonical three under off-vocabulary rather than refusing", () => {
		expect(countsOf([surface({disposition: "warn"})]).offVocabulary).toBe(1);
	});

	it("renders the header and one line per surface", () => {
		const out = runConfig({
			roster: resolvedRoster([skill("build", "---\nname: build\ndescription: d\n---\n")]),
			surfaces: [surface({})],
			json: false,
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe(
			"config\tsatisfied\t1\t0\t0\t0\nsurface\tbuild\t-\tdegrade\tpresent\t-\tROADMAP.md\t2026-08-09T14:22:03Z\n",
		);
	});
});

describe("status board", () => {
	const counted = (name: string, count: number): Bucket => ({
		name,
		count,
		selector: `labels=${name}`,
		detail: null,
		asOf: AS_OF,
	});
	const absentLabel = (name: string): Bucket => ({
		name,
		count: null,
		selector: `labels=${name}`,
		detail: "label absent",
		asOf: noAsOf,
	});

	/** A zero count means the label exists and nothing carries it; an absent label is unaskable. */
	it("renders an absent label as `unknown`, never as 0", () => {
		const read: BoardRead = {
			_tag: "Read",
			repo: "acme/storefront",
			buckets: [absentLabel("needs-triage"), counted("in-flight", 0)],
		};
		expect(boardState(read.buckets)).toBe("unknown");
		const out = runBoard({read, json: false});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toContain(
			"bucket\tneeds-triage\tunknown\tlabels=needs-triage\tlabel absent\tunknown",
		);
		expect(out.stdout).toContain("bucket\tin-flight\t0\t");
	});

	it("refuses on 11 when the repository could not be read at all", () => {
		const out = runBoard({
			read: {_tag: "Failed", repo: "acme/storefront", reason: "EAI_AGAIN"},
			json: false,
		});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("never 0");
	});
});

describe("status readout", () => {
	it("takes the MOST RECENTLY UPDATED comment carrying the heading, so staleness cannot hide", () => {
		const picked = digestComment([
			{body: "## Governance readout\nold", updatedAt: "2026-08-01T00:00:00Z"},
			{body: "## Governance readout\nnew", updatedAt: "2026-08-09T00:00:00Z"},
			{body: "unrelated", updatedAt: "2026-08-10T00:00:00Z"},
		]);
		expect(picked?.body).toContain("new");
	});

	it("resolves no digest comment to null rather than to an empty one", () => {
		expect(digestComment([{body: "unrelated", updatedAt: "2026-08-10T00:00:00Z"}])).toBeNull();
	});

	it("reads only a positive integer as an issue number", () => {
		expect(issueNumberOf("9412")).toBe(9412);
		expect(issueNumberOf("abc")).toBeNull();
		expect(issueNumberOf("0")).toBeNull();
		expect(issueNumberOf("-3")).toBeNull();
	});

	/** An unbuilt decoder is a failed read, not a proven-empty artifact (#5199). */
	it("refuses on 11 with the unregistered-format reason, and never reports `absent`", () => {
		const out = runReadout({read: {_tag: "NoFormat"}, json: false});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("is not registered");
		expect(out.stderr.join("\n")).toContain("never absent");
	});

	it("renders a proven-absent artifact as `absent` at exit 0 — a fact the caller acts on", () => {
		const out = runReadout({read: {_tag: "NoArtifact", repo: "acme/storefront"}, json: false});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("readout\tabsent\t0\tacme/storefront\tunknown\n");
	});
});

describe("status bootstrap", () => {
	it("refuses an id outside the registry on 12, naming what IS buildable", () => {
		expect(findSurface("merge-queue")).toBeUndefined();
		expect(knownIds()).toBe(
			"design-manifest, roadmap-focus, label-taxonomy, issue-shape-markers, readout-artifact",
		);
	});

	it("carries exactly five ids", () => {
		expect(BUILDABLE_SURFACES).toHaveLength(5);
		expect(NOT_BUILDABLE).toBe(12);
	});

	it("builds every issue-shape marker the ideation skills mint issues with", () => {
		expect(ISSUE_SHAPE_MARKERS.map((label) => label.name)).toEqual([
			"wayfinding:map",
			"prototyping:spike",
			"grilling:session",
		]);
	});

	it("mints every marker at one fixed colour and in the marker description grammar", () => {
		for (const label of ISSUE_SHAPE_MARKERS) {
			expect(label.color).toBe(MARKER_COLOR);
			expect(label.description).toMatch(
				/^issue-shape marker: a .+ \(not a pipeline state, not pickable\)$/,
			);
		}
		expect(MARKER_COLOR).toBe("1D76DB");
	});

	it("keeps the markers a surface of their own — no taxonomy label is a marker", () => {
		const taxonomy = new Set(TAXONOMY.map((label) => label.name));
		for (const label of ISSUE_SHAPE_MARKERS) expect(taxonomy.has(label.name)).toBe(false);
		expect(TAXONOMY.every((label) => label.color === null)).toBe(true);
	});
});

describe("status open is TOTAL — every unreadable source is a field state, never a refusal", () => {
	it("renders four fields at exit 0 when EVERY source failed", () => {
		const fields = [
			menuField({_tag: "Failed", path: "/x", display: "x", reason: "EACCES"}, AS_OF),
			configField({_tag: "Failed", path: "/x", display: "x", reason: "EACCES"}, [], AS_OF),
			boardField({_tag: "Failed", repo: "acme/storefront", reason: "EAI_AGAIN"}),
			readoutField({_tag: "NoFormat"}),
		];
		const out = runOpen({fields, json: false, scope: "roster x; repo acme/storefront"});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout.split("\n")[0]).toBe("open\t4");
		expect(out.stdout.split("\n").filter((l) => l.startsWith("field\t"))).toHaveLength(4);
		for (const field of fields) expect(field.state).toBe("unknown");
	});

	it("renders a resolved-but-empty roster as `empty`/`gaps`, not `unknown` and not `satisfied`", () => {
		expect(menuField(resolvedRoster([]), AS_OF).state).toBe("empty");
		const config = configField(resolvedRoster([]), [], AS_OF);
		expect(config.state).toBe("gaps");
		expect(config.detail).toBe("empty roster — nothing declared, nothing proven");
	});

	it("has exactly one refusal seat, and it is the off-vocabulary `--field`", () => {
		const out = badFieldRefusal("nope");
		expect(out.code).toBe(report.CLASSIFIED);
		expect(out.stdout).toBe("");
	});

	it("never prints an absolute machine-local path as a field's source", () => {
		const source = menuField(resolvedRoster([]), AS_OF).source;
		expect(source).toBe("claude-plugins/fabrika/skills");
		expect(source.startsWith("/")).toBe(false);
	});
});

describe("the tab-separated field discipline", () => {
	it("strips tabs and newlines out of prose before it is joined into a row", () => {
		expect(oneLine("a\tb\nc", 120)).toBe("a b c");
	});

	it("clamps after reproducing the raw text, so a truncated detail stays attributable", () => {
		expect(oneLine("x".repeat(200), 120)).toHaveLength(120);
	});
});
