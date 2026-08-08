import {describe, expect, it} from "vitest";
import {
	composeBody,
	detect,
	MARKER_RE,
	renderMarker,
	SUMMARY_LINE,
	wrapOriginal,
} from "./enrich.ts";
import {legacyPreserved} from "./enrich-legacy.ts";

const ISSUE = 4312;
const OTHER = 4290;

const ORIGINAL = "## Summary\n\nThe editor loses focus after a save.";
const REWRITE = "## What to build\n\nKeep focus on the editor across a save.";
const PITCH =
	"**Problem:** yazars lose their place\n**Arc:** fabrika campaign\n**Appetite:** 2 cycles\n**Rabbit-holes:** none\n**No-gos:** no rewrite";

/** A first enrichment in default mode, exactly as the verb composes it. */
const enrichedDefault = (issue = ISSUE): string =>
	composeBody({
		mode: "rewrite",
		issue,
		authored: REWRITE,
		preserved: wrapOriginal("rewrite", ORIGINAL),
	});

/** A first enrichment in `--epic` mode. */
const enrichedEpic = (issue = ISSUE): string =>
	composeBody({mode: "wrap", issue, authored: PITCH, preserved: wrapOriginal("wrap", ORIGINAL)});

/**
 * The RETIRED `--epic` shape detector, reproduced here as the control.
 *
 * It is what `contract.md` specified before the #4866 ruling, and reproducing it is the only way a
 * test can show the cross-mode failure is a property of shape inspection rather than of one buggy
 * line — under it the cross-mode re-run below returns `false` and the verb wraps a second time.
 */
const retiredEpicAnchors = (body: string): boolean => {
	const lines = body.split("\n");
	const headerAt = lines.indexOf("## Epic — awaiting plan");
	const briefAt = lines.indexOf(SUMMARY_LINE.wrap);
	return lines[0] === "## Pitch" && headerAt !== -1 && briefAt > headerAt;
};

/** The RETIRED default-mode detector: the summary line's block closes at end of body. */
const retiredTerminality = (body: string): boolean => {
	const lines = body.split("\n").filter((line) => line.trim() !== "");
	return lines.includes(SUMMARY_LINE.rewrite) && lines.at(-1) === "</details>";
};

const summaryLines = (body: string): ReadonlyArray<string> =>
	body.split("\n").filter((line) => line === SUMMARY_LINE.rewrite || line === SUMMARY_LINE.wrap);

const markerLines = (body: string): ReadonlyArray<string> =>
	body.split("\n").filter((line) => MARKER_RE.test(line));

describe("the composed envelope", () => {
	it("writes the marker on its own line, directly above the preserved block", () => {
		expect(enrichedDefault()).toBe(
			`${REWRITE}\n\n---\n\n<!-- fabrika:enriched issue=4312 mode=rewrite -->\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`,
		);
	});

	it("heads the pitch under the two headings pitch-guard anchors on, in --epic mode", () => {
		expect(enrichedEpic()).toBe(
			`## Pitch\n\n${PITCH}\n\n## Epic — awaiting plan\n\n\`plan-epic\` appends its plan and dependency topology below.\n\n<!-- fabrika:enriched issue=4312 mode=wrap -->\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n`,
		);
	});

	it("binds the issue number and the mode into the marker", () => {
		expect(renderMarker(4312, "rewrite")).toBe("<!-- fabrika:enriched issue=4312 mode=rewrite -->");
		expect(renderMarker(4290, "wrap")).toBe("<!-- fabrika:enriched issue=4290 mode=wrap -->");
	});

	it("matches the marker anchored to a whole line, never as a substring", () => {
		expect(MARKER_RE.test("<!-- fabrika:enriched issue=4312 mode=rewrite -->")).toBe(true);
		expect(
			MARKER_RE.test("the body carried <!-- fabrika:enriched issue=4312 mode=rewrite --> inline"),
		).toBe(false);
		expect(MARKER_RE.test("<!-- fabrika:enriched issue=abc mode=rewrite -->")).toBe(false);
		expect(MARKER_RE.test("<!-- fabrika:enriched issue=4312 -->")).toBe(false);
	});
});

describe("detect — the marker is the whole rule, and it is mode-independent (#4866)", () => {
	it("reads a fresh, never-enriched body as Fresh", () => {
		const detection = detect(ORIGINAL, ISSUE, legacyPreserved);
		expect(detection).toMatchObject({_tag: "Fresh", reason: "no marker"});
	});

	it("reads a body that MENTIONS the marker mid-line as fresh, never as enriched", () => {
		// A bug report about this very format is an ordinary filing here. Treating its prose as a
		// marker would overwrite the reporter's own text above the mention.
		const talking = `The verb writes <!-- fabrika:enriched issue=4312 mode=rewrite --> above the block.\n\n${ORIGINAL}`;
		expect(detect(talking, ISSUE, legacyPreserved)).toMatchObject({_tag: "Fresh"});
	});

	it("recognises this issue's own default-mode envelope", () => {
		const detection = detect(enrichedDefault(), ISSUE, legacyPreserved);
		expect(detection).toMatchObject({_tag: "Enriched", via: "marker", markedMode: "rewrite"});
	});

	it("recognises a DEFAULT-mode envelope that the retired --epic shape detector could not (#4866)", () => {
		const body = enrichedDefault();
		// The control: shape inspection misses it, which is exactly how the verb came to wrap a second
		// time and nest the previous provenance boundary inside a fresh block.
		expect(retiredEpicAnchors(body)).toBe(false);
		expect(detect(body, ISSUE, legacyPreserved)).toMatchObject({_tag: "Enriched", via: "marker"});
	});

	it("recognises an --epic envelope that the retired terminality test could not (#4866, reverse direction)", () => {
		const planned = `${enrichedEpic()}\n## Plan (plan-epic)\n\nPhase 1: #4400\n`;
		expect(retiredTerminality(planned)).toBe(false);
		expect(detect(planned, ISSUE, legacyPreserved)).toMatchObject({
			_tag: "Enriched",
			via: "marker",
			markedMode: "wrap",
		});
	});

	it("preserves the block AND every byte below it, so a plan is never deleted", () => {
		const tail = `<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n\n## Plan (plan-epic)\n\nPhase 1: #4400\n\n## Dependencies\n\n#4400 requires: none\n`;
		const planned = composeBody({mode: "wrap", issue: ISSUE, authored: PITCH, preserved: tail});
		const detection = detect(planned, ISSUE, legacyPreserved);
		expect(detection).toMatchObject({_tag: "Enriched"});
		if (detection._tag !== "Enriched") throw new Error("unreachable");
		expect(detection.preserved).toBe(tail);
	});
});

describe("the marker binds the issue number — a paste reads as FRESH", () => {
	it("reads another issue's enriched body, pasted here, as a first enrichment", () => {
		const detection = detect(enrichedDefault(OTHER), ISSUE, legacyPreserved);
		expect(detection).toMatchObject({
			_tag: "Fresh",
			reason: "marker binds another issue",
			boundTo: OTHER,
		});
	});

	it("reads a pasted --epic envelope as fresh even though its shape is a perfect match", () => {
		const pasted = enrichedEpic(OTHER);
		// The shape detector the ruling retired would have accepted this and overwritten the reporter's
		// text above it. The binding is what refuses it.
		expect(retiredEpicAnchors(pasted)).toBe(true);
		expect(detect(pasted, ISSUE, legacyPreserved)).toMatchObject({_tag: "Fresh"});
	});

	it("never consults the legacy shapes for a foreign-marker body, however v1-shaped it is", () => {
		// A paste that is BOTH marker-bearing (bound elsewhere) and a perfect v1 default envelope: the
		// short-circuit is what stops the legacy door from re-admitting the impersonation.
		const pasted = `${REWRITE}\n\n---\n\n${renderMarker(OTHER, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>`;
		expect(legacyPreserved(pasted)).not.toBeNull();
		expect(detect(pasted, ISSUE, legacyPreserved)).toMatchObject({
			_tag: "Fresh",
			boundTo: OTHER,
		});
	});

	it("splits on the FIRST marker, so a marker buried in preserved content is never the boundary", () => {
		const buried = wrapOriginal("rewrite", `${renderMarker(OTHER, "wrap")}\n${ORIGINAL}`);
		const body = composeBody({mode: "rewrite", issue: ISSUE, authored: REWRITE, preserved: buried});
		const detection = detect(body, ISSUE, legacyPreserved);
		expect(detection).toMatchObject({_tag: "Enriched", markedMode: "rewrite"});
		if (detection._tag !== "Enriched") throw new Error("unreachable");
		expect(detection.preserved).toBe(buried);
	});
});

describe("legacy migration — recognise once, stamp in passing, never wrap twice", () => {
	const legacyDefault = `${REWRITE}\n\n---\n\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`;
	const legacyEpic = `## Pitch\n\n${PITCH}\n\n## Epic — awaiting plan\n\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n\n## Plan (plan-epic)\n\nPhase 1: #4400\n`;

	it("recognises a v1 default envelope and hands back the block as the preserved region", () => {
		const detection = detect(legacyDefault, ISSUE, legacyPreserved);
		expect(detection).toMatchObject({_tag: "Enriched", via: "legacy", markedMode: null});
		if (detection._tag !== "Enriched") throw new Error("unreachable");
		expect(detection.preserved).toBe(
			`<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`,
		);
	});

	it("recognises a v1 --epic envelope even once plan-epic has appended below it", () => {
		const detection = detect(legacyEpic, ISSUE, legacyPreserved);
		expect(detection).toMatchObject({_tag: "Enriched", via: "legacy"});
		if (detection._tag !== "Enriched") throw new Error("unreachable");
		expect(detection.preserved).toBe(
			`<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n\n## Plan (plan-epic)\n\nPhase 1: #4400\n`,
		);
	});

	it("converts a legacy body to a marked one in one pass, with no second envelope", () => {
		const detection = detect(legacyDefault, ISSUE, legacyPreserved);
		if (detection._tag !== "Enriched") throw new Error("unreachable");
		const migrated = composeBody({
			mode: "rewrite",
			issue: ISSUE,
			authored: REWRITE,
			preserved: detection.preserved,
		});
		expect(summaryLines(migrated)).toEqual([SUMMARY_LINE.rewrite]);
		expect(markerLines(migrated)).toEqual([renderMarker(ISSUE, "rewrite")]);
		// And the migration is one-way: the second pass goes through the marker, never the legacy door.
		expect(detect(migrated, ISSUE, legacyPreserved)).toMatchObject({via: "marker"});
	});

	it("refuses a body that merely QUOTES an envelope below the reporter's own framing", () => {
		const quoting = `I filed this because the format below looks wrong to me:\n\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n\nWhat should it be?\n`;
		expect(legacyPreserved(quoting)).toBeNull();
		expect(detect(quoting, ISSUE, legacyPreserved)).toMatchObject({_tag: "Fresh"});
	});

	it("refuses a pitch that quotes the summary line ABOVE the epic header", () => {
		const quoting = `## Pitch\n\n${PITCH}\n\n${SUMMARY_LINE.wrap}\n\n## Epic — awaiting plan\n`;
		expect(legacyPreserved(quoting)).toBeNull();
	});

	it("refuses an otherwise-perfect epic envelope that does not OPEN at byte 0 with ## Pitch", () => {
		// Only the byte-0 anchor separates this from a real v1 epic envelope: the reporter's framing
		// prose sits above it, which is what a quoting filing looks like.
		const quoting = `Here is what our epics look like:\n\n## Pitch\n\n${PITCH}\n\n## Epic — awaiting plan\n\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n`;
		expect(legacyPreserved(quoting)).toBeNull();
	});

	it("refuses a pitched body carrying no epic header", () => {
		const headerless = `## Pitch\n\n${PITCH}\n\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n`;
		expect(legacyPreserved(headerless)).toBeNull();
	});

	it("refuses a v1 default envelope whose block does not close at end of body", () => {
		expect(legacyPreserved(`${legacyDefault}\nA trailing paragraph.\n`)).toBeNull();
	});

	it("refuses a summary line with no <details> opener above it", () => {
		expect(legacyPreserved(`${REWRITE}\n\n${SUMMARY_LINE.rewrite}\n\n</details>\n`)).toBeNull();
	});
});

describe("idempotency — a second pass converges, in either mode", () => {
	it("produces the same body twice in default mode", () => {
		const first = enrichedDefault();
		const detection = detect(first, ISSUE, legacyPreserved);
		if (detection._tag !== "Enriched") throw new Error("unreachable");
		const second = composeBody({
			mode: "rewrite",
			issue: ISSUE,
			authored: REWRITE,
			preserved: detection.preserved,
		});
		expect(second).toBe(first);
	});

	it("converges over a PLANNED epic body, and never accumulates a level", () => {
		const planned = `${enrichedEpic()}\n## Plan (plan-epic)\n\nPhase 1: #4400\n`;
		let body = planned;
		for (let pass = 0; pass < 3; pass++) {
			const detection = detect(body, ISSUE, legacyPreserved);
			if (detection._tag !== "Enriched") throw new Error(`pass ${pass} read as fresh`);
			body = composeBody({
				mode: "wrap",
				issue: ISSUE,
				authored: PITCH,
				preserved: detection.preserved,
			});
		}
		expect(body).toBe(planned);
		expect(summaryLines(body)).toEqual([SUMMARY_LINE.wrap]);
		expect(markerLines(body)).toHaveLength(1);
	});

	it("converges across a MODE SWITCH — the class #4866 tracks", () => {
		const detection = detect(enrichedDefault(), ISSUE, legacyPreserved);
		if (detection._tag !== "Enriched") throw new Error("unreachable");
		const converted = composeBody({
			mode: "wrap",
			issue: ISSUE,
			authored: PITCH,
			preserved: detection.preserved,
		});
		// One envelope, and it is still the DEFAULT-mode one: the preserved original was never re-wrapped.
		expect(summaryLines(converted)).toEqual([SUMMARY_LINE.rewrite]);
		expect(markerLines(converted)).toEqual([renderMarker(ISSUE, "wrap")]);
		expect(converted).toContain(`<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>`);
	});
});
