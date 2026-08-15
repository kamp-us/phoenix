import {Effect, FileSystem, Layer, Path, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {AUDIENCE_NOT_AGENT, BAD_SECTIONS, OUT_OF_FOCUS, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	ADMISSION_EXIT_CODES,
	type Admission,
	admissionOf,
	admissionRefusal,
	audienceAxisBinds,
	audienceAxisOf,
	CLAIM_PURPOSES,
	DEFAULT_CLAIM_PURPOSE,
	DEFAULT_ROADMAP,
	exclusionReasonOf,
	type Focus,
	focusReport,
	focusScopeLine,
	homeOf,
	type IssueFacts,
	noServedIssue,
	parseClaimPurpose,
	purposeScopeLine,
	readDeclaredFocus,
	readFocus,
	STANDING_LANE_LABELS,
	scopeAxisOf,
	scopeSubjectOf,
	unknownAdmission,
} from "./scope-admission.ts";

const FOCUS_44 = `## Focus

Prose above the table, including a \`Milestone | Declared\` mention that is not a table row.

| Milestone | Declared |
|-----------|----------|
| #44 | 2026-08-09 |

**The grammar.** More prose below.

## Dependencies
`;

const declared: Focus = {_tag: "Declared", milestone: 44, declared: "2026-08-09"};
const noFocus: Focus = {_tag: "None"};

const issue = (over: Partial<IssueFacts> = {}): IssueFacts => ({
	number: 1,
	labels: ["status:triaged", "p0", "ready-for:agent"],
	milestone: 44,
	...over,
});

describe("readFocus", () => {
	it("reads the one data row, ignoring prose, the header and the separator", () => {
		expect(readFocus(FOCUS_44)).toEqual(declared);
	});

	it("reads a missing section as the well-formed default: no focus declared", () => {
		expect(
			readFocus("# Roadmap\n\n## Arcs\n\n| Arc | Milestone |\n|---|---|\n| Geçit | #24 |\n"),
		).toEqual(noFocus);
	});

	it("reads a present-but-empty table as the same well-formed default", () => {
		expect(
			readFocus("## Focus\n\n| Milestone | Declared |\n|-----------|----------|\n\n## Next\n"),
		).toEqual(noFocus);
	});

	it("refuses two data rows — exclusive focus admits at most one", () => {
		const two =
			"## Focus\n\n| Milestone | Declared |\n|---|---|\n| #44 | 2026-08-09 |\n| #24 | 2026-08-01 |\n";
		expect(readFocus(two)._tag).toBe("Malformed");
	});

	it("refuses a milestone cell that is not #<int> — never reading it as 'no focus'", () => {
		const bare = "## Focus\n\n| Milestone | Declared |\n|---|---|\n| 44 | 2026-08-09 |\n";
		const parsed = readFocus(bare);
		expect(parsed._tag).toBe("Malformed");
		expect(parsed._tag === "Malformed" && parsed.reason).toContain("#<int>");
	});

	it("refuses a date that is not ISO, and a four-two-two that is not a calendar day", () => {
		const slashes = "## Focus\n\n| Milestone | Declared |\n|---|---|\n| #44 | 09/08/2026 |\n";
		const notADay = "## Focus\n\n| Milestone | Declared |\n|---|---|\n| #44 | 2026-02-31 |\n";
		expect(readFocus(slashes)._tag).toBe("Malformed");
		expect(readFocus(notADay)._tag).toBe("Malformed");
	});

	it("refuses a renamed header rather than skipping it into invisibility", () => {
		const renamed = "## Focus\n\n| Campaign | Declared |\n|---|---|\n| #44 | 2026-08-09 |\n";
		expect(readFocus(renamed)._tag).toBe("Malformed");
	});
});

describe("the two axes stay apart", () => {
	it("scope reads campaign membership only — an out-of-focus issue is refused whatever its audience", () => {
		expect(scopeAxisOf(declared, issue({milestone: 24}))).toEqual({
			_tag: "OutOfFocus",
			focus: 44,
			home: "24",
		});
		expect(audienceAxisOf(issue({milestone: 24}))).toEqual({_tag: "Agent"});
	});

	it("audience reads the ready-for: label only — an in-focus issue can still fail it", () => {
		const humanOwned = issue({labels: ["ready-for:human"]});
		expect(scopeAxisOf(declared, humanOwned)).toEqual({_tag: "InFocus", milestone: 44});
		expect(audienceAxisOf(humanOwned)).toEqual({_tag: "NotAgent", label: "ready-for:human"});
	});

	it("carries both axis verdicts on a refusal, so neither is lost behind the other", () => {
		const both = admissionOf(declared, issue({milestone: 24, labels: ["ready-for:human"]}));
		expect(both._tag).toBe("OutOfFocus");
		expect(both._tag === "OutOfFocus" && both.audience).toEqual({
			_tag: "NotAgent",
			label: "ready-for:human",
		});
	});
});

describe("admissionOf", () => {
	it("admits an in-focus, agent-audience issue", () => {
		const out = admissionOf(declared, issue());
		expect(out._tag).toBe("Admitted");
		expect(out._tag === "Admitted" && out.scope).toEqual({_tag: "InFocus", milestone: 44});
		expect(admissionRefusal("build claim", out)).toBeNull();
		expect(exclusionReasonOf(out)).toBeNull();
	});

	it("refuses an out-of-focus issue on the scope axis, at 20", () => {
		const out = admissionOf(declared, issue({milestone: 24}));
		expect(out._tag).toBe("OutOfFocus");
		expect(exclusionReasonOf(out)).toBe("out-of-focus");
		expect(admissionRefusal("build claim", out)?.code).toBe(OUT_OF_FOCUS);
	});

	it("refuses a milestone-less issue with no standing lane, naming the absent home", () => {
		const out = admissionOf(declared, issue({milestone: null}));
		const refusal = admissionRefusal("build claim", out);
		expect(refusal?.code).toBe(OUT_OF_FOCUS);
		expect(refusal?.stderr.join("\n")).toContain("no milestone and no standing lane");
	});

	for (const lane of STANDING_LANE_LABELS) {
		it(`admits ${lane} by exemption despite carrying no milestone`, () => {
			const standing = issue({milestone: null, labels: ["ready-for:agent", "p2", lane]});
			expect(homeOf(standing)).toBe(lane);
			const out = admissionOf(declared, standing);
			expect(out._tag).toBe("Admitted");
			expect(out._tag === "Admitted" && out.scope).toEqual({_tag: "LaneExempt", lane});
		});
	}

	it("refuses ready-for:human on the audience axis, at 21 — never at 20", () => {
		const out = admissionOf(declared, issue({labels: ["ready-for:human"]}));
		expect(out._tag).toBe("AudienceNotAgent");
		expect(exclusionReasonOf(out)).toBe("audience-not-agent");
		expect(admissionRefusal("build claim", out)?.code).toBe(AUDIENCE_NOT_AGENT);
	});

	it("refuses an absent ready-for: label — absence is an unknown audience, never an agent one", () => {
		const out = admissionOf(declared, issue({labels: ["status:triaged", "p0"]}));
		expect(out._tag).toBe("AudienceNotAgent");
		expect(out._tag === "AudienceNotAgent" && out.audience.label).toBeNull();
		expect(admissionRefusal("build claim", out)?.code).toBe(AUDIENCE_NOT_AGENT);
	});

	it("still applies the audience axis to a standing lane", () => {
		const standing = issue({milestone: null, labels: ["axis:pipeline-hardening"]});
		expect(admissionOf(declared, standing)._tag).toBe("AudienceNotAgent");
	});

	it("admits everything with no declaration, and records the fence inert", () => {
		const out = admissionOf(noFocus, issue({milestone: 24}));
		expect(out._tag).toBe("Admitted");
		expect(out._tag === "Admitted" && out.scope).toEqual({_tag: "Inert"});
		expect(focusScopeLine("build pick", noFocus)).toContain("none declared — scope fence inert");
		expect(focusReport(noFocus)).toEqual({state: "none"});
	});

	/**
	 * The purpose axis (#5175). Every case varies the purpose over one unlabelled, in-focus issue —
	 * the epic shape the ruling rests on — so what changes is only which question the claim asks.
	 */
	describe("purpose", () => {
		const unlabelled = issue({labels: ["status:triaged", "type:epic"]});

		it("defaults to build, so an omitted purpose keeps the fence", () => {
			expect(DEFAULT_CLAIM_PURPOSE).toBe("build");
			expect(admissionOf(declared, unlabelled)._tag).toBe("AudienceNotAgent");
			expect(admissionOf(declared, unlabelled, DEFAULT_CLAIM_PURPOSE)._tag).toBe(
				"AudienceNotAgent",
			);
		});

		for (const purpose of ["plan", "gate"] as const) {
			it(`admits the same issue under ${purpose}, and still reports the audience it saw`, () => {
				const out = admissionOf(declared, unlabelled, purpose);
				expect(out._tag).toBe("Admitted");
				expect(out._tag === "Admitted" && out.audience).toEqual({_tag: "NotAgent", label: null});
				expect(audienceAxisBinds(purpose)).toBe(false);
			});
		}

		for (const purpose of CLAIM_PURPOSES) {
			it(`leaves the scope axis alone under ${purpose} — out of focus is still 20`, () => {
				const out = admissionOf(declared, issue({milestone: 24}), purpose);
				expect(out._tag).toBe("OutOfFocus");
				expect(admissionRefusal("build claim", out)?.code).toBe(OUT_OF_FOCUS);
			});
		}

		it("reads only the three named purposes — an off-enum value is null, never build", () => {
			expect(CLAIM_PURPOSES.map(parseClaimPurpose)).toEqual([...CLAIM_PURPOSES]);
			expect(parseClaimPurpose("planning")).toBeNull();
			expect(parseClaimPurpose("")).toBeNull();
			expect(parseClaimPurpose("BUILD")).toBeNull();
		});

		it("says on the purpose line whether the audience axis bound this claim", () => {
			const audience = audienceAxisOf(unlabelled);
			expect(purposeScopeLine("build claim", "build", audience)).toContain(
				"the audience axis binds",
			);
			expect(purposeScopeLine("build claim", "gate", audience)).toContain(
				"the audience axis does not bind a gate claim (#5175)",
			);
		});
	});

	it("resolves a malformed declaration to UNKNOWN at 4, never to admitted", () => {
		const out = admissionOf({_tag: "Malformed", reason: "two data rows"}, issue());
		expect(out._tag).toBe("Unknown");
		expect(exclusionReasonOf(out)).toBe("unreadable");
		expect(admissionRefusal("build pick", out)?.code).toBe(BAD_SECTIONS);
	});

	it("resolves an unreadable input to UNKNOWN at 11, and prints nothing on stdout", () => {
		const out: Admission = unknownAdmission("cannot read #7: gh: Bad Gateway (HTTP 502)");
		const refusal = admissionRefusal("build claim", out);
		expect(refusal?.code).toBe(PRECONDITION_UNKNOWN);
		expect(refusal?.stdout).toBe("");
	});

	it("reuses the matrix's indefinite code rather than minting a second numeral for it", () => {
		expect(ADMISSION_EXIT_CODES.map((row) => row.code)).toEqual([
			BAD_SECTIONS,
			PRECONDITION_UNKNOWN,
			OUT_OF_FOCUS,
			AUDIENCE_NOT_AGENT,
		]);
		expect(new Set(ADMISSION_EXIT_CODES.map((row) => row.code)).size).toBe(4);
		expect(ADMISSION_EXIT_CODES.every((row) => row.condition.trim() !== "")).toBe(true);
	});
});

describe("readDeclaredFocus", () => {
	const read = (layer: Layer.Layer<FileSystem.FileSystem | Path.Path>, path = DEFAULT_ROADMAP) =>
		Effect.runPromise(Effect.provide(readDeclaredFocus(path), layer));

	it("reads the declaration off the roadmap", async () => {
		const out = await read(fakeFs({files: {[DEFAULT_ROADMAP]: FOCUS_44}}).layer);
		expect(out).toEqual({_tag: "Read", focus: declared});
	});

	it("reads an absent roadmap as no focus declared — the off switch, not a refusal", async () => {
		const out = await read(fakeFs({files: {}}).layer);
		expect(out).toEqual({_tag: "Read", focus: noFocus});
	});

	it("resolves an unprobeable roadmap to UNREADABLE, never to absent", async () => {
		const out = await read(fakeFs({files: {}, unprobeable: [DEFAULT_ROADMAP]}).layer);
		expect(out._tag).toBe("Unreadable");
	});

	it("resolves a roadmap that exists but cannot be read to UNREADABLE", async () => {
		const layer = Layer.merge(
			FileSystem.layerNoop({
				exists: () => Effect.succeed(true),
				readFileString: (path: string) =>
					Effect.fail(
						PlatformError.systemError({
							_tag: "PermissionDenied",
							module: "FileSystem",
							method: "readFileString",
							pathOrDescriptor: path,
						}),
					),
			}),
			Path.layer,
		);
		const out = await read(layer);
		expect(out._tag).toBe("Unreadable");
		expect(out._tag === "Unreadable" && out.reason).toContain(DEFAULT_ROADMAP);
	});
});

describe("scopeSubjectOf", () => {
	const pull = (body: string) => ({isPullRequest: true, body});

	it("reads an issue as its own subject, whatever its body says", () => {
		expect(scopeSubjectOf({isPullRequest: false, body: "Fixes #4312"})).toEqual({_tag: "Own"});
	});

	it("resolves a PR to the issue its closing keyword names", () => {
		expect(scopeSubjectOf(pull("A summary.\n\nFixes #4312\n"))).toEqual({
			_tag: "Served",
			number: 4312,
			kind: "fixes",
		});
	});

	it("resolves a partial PR through Part of #<n>, the reference review scope reads", () => {
		expect(scopeSubjectOf(pull("Part of #4312\n"))).toEqual({
			_tag: "Served",
			number: 4312,
			kind: "part-of",
		});
	});

	it("reads a PR naming no issue as unserved — never as an issue with an empty home", () => {
		expect(scopeSubjectOf(pull("A conversation-authored ADR.\n\n## Deviations\nNone.\n"))).toEqual({
			_tag: "Unserved",
		});
	});
});

describe("noServedIssue", () => {
	const unserved = noServedIssue(5556, 44, "carries no reference");

	it("refuses at 20, naming the case that fired and the remedy", () => {
		const refusal = admissionRefusal("build claim", unserved);
		expect(refusal?.code).toBe(OUT_OF_FOCUS);
		const text = refusal?.stderr.join("\n") ?? "";
		expect(text).toContain("no served issue");
		expect(text).toContain("PR #5556 carries no reference");
		expect(text).toContain("milestone #44");
		expect(text).toContain("explicit override");
	});

	it("is a scope-axis exclusion, never an unreadable one", () => {
		expect(exclusionReasonOf(unserved)).toBe("out-of-focus");
	});
});
