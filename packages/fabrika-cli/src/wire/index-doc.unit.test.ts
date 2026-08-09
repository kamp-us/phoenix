/**
 * Two tiers, and the second is what makes the first worth anything.
 *
 * The first drives the **committed doc** through the reconciliation, so the page reds the moment it
 * stops agreeing with the registry. The second drives deliberately drifted docs through the same
 * function and asserts each divergence is caught — a check that cannot fail reports agreement over a
 * page that has gone stale, which is the exact defect #4968 is about.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {VerbOutcome} from "../verb.ts";
import {ARTIFACT_UNKNOWN, MALFORMED, ZERO_SCOPE} from "./codes.ts";
import {brandWitnesses, type WireFormat, type WireReadLines} from "./format.ts";
import {
	BEGIN_MARKER,
	conformIndexDoc,
	DOC_PATH,
	describeIndexFindings,
	documentedKeys,
	END_MARKER,
	INDEX_LAWS,
	renderProjection,
	rewriteIndexDoc,
} from "./index-doc.ts";
import {type DocRead, type DocSave, runIndex} from "./index-verb.ts";
import {registeredFormats} from "./registry.ts";

const committedDoc = (): string =>
	readFileSync(fileURLToPath(new URL(`../../../../${DOC_PATH}`, import.meta.url)), "utf8");

const ANSWER = 0;

declare const TOY: unique symbol;
type ToyText = string & {readonly [TOY]: true};

const TOY_FORMAT: WireFormat = {
	key: "toy",
	purpose: "a registered format that exists only to be documented",
	module: "packages/fabrika-cli/src/wire/toy.ts",
	producers: ["triage"],
	consumers: ["build"],
	emit: (fields) => ({_tag: "Composed", bytes: `toy: ${fields.trim()}\n`}),
	read: (): WireReadLines => ({_tag: "Found", value: ["value\talpha"]}),
	fixtures: {
		roundTrip: {fields: "alpha", values: ["alpha"]},
		absent: "prose that reaches for nothing\n",
		malformed: [{drift: "the key drifted", artifact: "toyish: alpha\n"}],
	},
	brands: brandWitnesses<{readonly value: ToyText; readonly checked: boolean}>({value: true}),
};

const TOY_REGISTRY = [TOY_FORMAT];

/** A doc that agrees with `TOY_REGISTRY`, so each mutation below breaks exactly one law. */
const agreeingDoc = (formats = TOY_REGISTRY): string =>
	[
		"# the index",
		"",
		"## Registered formats",
		"",
		BEGIN_MARKER,
		renderProjection(formats),
		END_MARKER,
		"",
		...formats.flatMap((format) => [`### \`${format.key}\``, "", "Why the agreement exists.", ""]),
	].join("\n");

const lawsBrokenBy = (markdown: string, formats = TOY_REGISTRY): ReadonlyArray<string> => {
	const report = conformIndexDoc(markdown, formats);
	return report._tag === "Scanned" ? report.findings.map((finding) => finding.law) : [];
};

describe("the committed index doc agrees with the registry", () => {
	it("reconciles the real page against the real registry with no finding", () => {
		const report = conformIndexDoc(committedDoc(), registeredFormats);
		expect(report._tag, report._tag === "ZeroScope" ? report.reason : "").toBe("Scanned");
		if (report._tag !== "Scanned") return;
		expect(report.registered).toBe(registeredFormats.length);
		expect(describeIndexFindings(report.findings)).toBe("");
	});

	it("documents every registered format and nothing else", () => {
		expect([...documentedKeys(committedDoc())].sort()).toEqual(
			registeredFormats.map((format) => format.key).sort(),
		);
	});

	it("carries the region the generator owns, rendered from the registry as it stands", () => {
		expect(committedDoc()).toContain(renderProjection(registeredFormats));
	});
});

describe("the check bites — each drift is caught", () => {
	it("the baseline agrees, so every case below fails for its own reason", () => {
		const report = conformIndexDoc(agreeingDoc(), TOY_REGISTRY);
		expect(report._tag).toBe("Scanned");
		if (report._tag !== "Scanned") return;
		expect(describeIndexFindings(report.findings)).toBe("");
	});

	it("catches a registered format the doc never got a section for", () => {
		const second: WireFormat = {...TOY_FORMAT, key: "toy-two"};
		// The doc is rendered for BOTH rows, so only the missing narrative section is left to catch.
		const markdown = agreeingDoc([TOY_FORMAT, second]).replace(
			"### `toy-two`\n\nWhy the agreement exists.\n",
			"",
		);
		expect(lawsBrokenBy(markdown, [TOY_FORMAT, second])).toContain(INDEX_LAWS.documented);
	});

	it("catches a documented format that is registered nowhere", () => {
		const markdown = `${agreeingDoc()}\n### \`retired\`\n\nA section outliving its row.\n`;
		expect(lawsBrokenBy(markdown)).toContain(INDEX_LAWS.registered);
	});

	it("catches a hand-edited generated region — the projection the generator owns", () => {
		const markdown = agreeingDoc().replace("`triage`", "`triage`, `review`");
		expect(lawsBrokenBy(markdown)).toContain(INDEX_LAWS.projection);
	});

	it("catches a producers/consumers change made on the registry side alone", () => {
		const renamed: WireFormat = {...TOY_FORMAT, consumers: ["build", "ship"]};
		expect(lawsBrokenBy(agreeingDoc(), [renamed])).toContain(INDEX_LAWS.projection);
	});

	it("catches an owner module that moved under the doc's feet", () => {
		const moved: WireFormat = {...TOY_FORMAT, module: "packages/fabrika-cli/src/wire/moved.ts"};
		expect(lawsBrokenBy(agreeingDoc(), [moved])).toContain(INDEX_LAWS.projection);
	});
});

describe("zero scope is a refusal, never agreement (ADR 0092)", () => {
	it.each([
		["an empty doc", "", TOY_REGISTRY],
		["a doc with no generated region", "# the index\n\n### `toy`\n\nnarrative\n", TOY_REGISTRY],
		[
			"a doc with no format section",
			`${BEGIN_MARKER}\n${renderProjection(TOY_REGISTRY)}\n${END_MARKER}\n`,
			TOY_REGISTRY,
		],
		["an empty registry", agreeingDoc(), []],
	])("refuses %s rather than reporting zero findings", (_case, markdown, formats) => {
		const report = conformIndexDoc(markdown, formats);
		expect(report._tag).toBe("ZeroScope");
		if (report._tag !== "ZeroScope") return;
		expect(report.reason).not.toBe("");
	});
});

describe("the generator is the region's only writer", () => {
	it("renders a hand-edited region back to what the registry says", () => {
		const drifted = agreeingDoc().replace("`triage`", "`someone typed this`");
		const rewritten = rewriteIndexDoc(drifted, TOY_REGISTRY);
		expect(rewritten._tag).toBe("Rewritten");
		if (rewritten._tag !== "Rewritten") return;
		expect(rewritten.markdown).toContain(renderProjection(TOY_REGISTRY));
		expect(rewritten.markdown).not.toContain("someone typed this");
		expect(lawsBrokenBy(rewritten.markdown)).toEqual([]);
	});

	it("leaves the hand-written narrative outside the region untouched", () => {
		const withNote = agreeingDoc().replace(
			"Why the agreement exists.",
			"A paragraph only a human has.",
		);
		const rewritten = rewriteIndexDoc(withNote, TOY_REGISTRY);
		expect(rewritten._tag).toBe("Rewritten");
		if (rewritten._tag !== "Rewritten") return;
		expect(rewritten.markdown).toContain("A paragraph only a human has.");
	});

	it("refuses to render an empty registry over the region — that deletes the index, it does not derive it", () => {
		expect(rewriteIndexDoc(agreeingDoc(), [])._tag).toBe("ZeroScope");
	});

	it("refuses a doc with no region rather than inventing where the table goes", () => {
		expect(rewriteIndexDoc("# the index\n\n### `toy`\n\nnarrative\n", TOY_REGISTRY)._tag).toBe(
			"ZeroScope",
		);
	});
});

describe("wire index seats each outcome on its own code", () => {
	const saves = (): Effect.Effect<DocSave> => Effect.succeed({_tag: "Saved"});

	const index = (options: {
		readonly doc: DocRead;
		readonly write?: boolean;
		readonly formats?: ReadonlyArray<WireFormat>;
		readonly save?: (markdown: string) => Effect.Effect<DocSave>;
	}): VerbOutcome =>
		Effect.runSync(
			runIndex({
				write: options.write ?? false,
				json: false,
				formats: options.formats ?? TOY_REGISTRY,
				doc: Effect.succeed(options.doc),
				save: options.save ?? saves,
			}),
		);

	const DRIFTED: DocRead = {
		_tag: "Text",
		text: `${agreeingDoc()}\n### \`retired\`\n\nstale\n`,
	};
	const UNREADABLE: DocRead = {_tag: "Failed", reason: "ENOENT"};

	it("answers agreement on 0, with the counts it judged", () => {
		const out = index({doc: {_tag: "Text", text: agreeingDoc()}});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("index\tagrees\t1\t1\n");
	});

	it("seats a disagreement on MALFORMED with nothing on stdout, naming the finding", () => {
		const out = index({doc: DRIFTED});
		expect(out.code).toBe(MALFORMED);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("retired");
	});

	it("refuses a doc it never read as UNKNOWN — not as a disagreement", () => {
		const out = index({doc: UNREADABLE});
		expect(out.code).toBe(ARTIFACT_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses zero scope rather than passing vacuously", () => {
		expect(index({doc: {_tag: "Text", text: agreeingDoc()}, formats: []}).code).toBe(ZERO_SCOPE);
	});

	it("writes the rendered doc back and then re-checks what it wrote", () => {
		const box: {last: string} = {last: ""};
		const out = index({
			write: true,
			doc: {_tag: "Text", text: agreeingDoc().replace("`triage`", "`drifted`")},
			save: (markdown) => {
				box.last = markdown;
				return Effect.succeed({_tag: "Saved"});
			},
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("index\twritten\t1\t1\n");
		expect(box.last).toContain(renderProjection(TOY_REGISTRY));
	});

	it("still reds after a write when a narrative section is missing — the generator cannot author prose", () => {
		const second: WireFormat = {...TOY_FORMAT, key: "toy-two"};
		const out = index({
			write: true,
			doc: {_tag: "Text", text: agreeingDoc()},
			formats: [TOY_FORMAT, second],
		});
		expect(out.code).toBe(MALFORMED);
		expect(out.stderr.join("\n")).toContain("toy-two");
	});

	it("refuses a doc it could not write back as UNKNOWN", () => {
		const out = index({
			write: true,
			doc: {_tag: "Text", text: agreeingDoc()},
			save: () => Effect.succeed({_tag: "Failed", reason: "EACCES"}),
		});
		expect(out.code).toBe(ARTIFACT_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("keeps disagreement, unreadable and zero scope on three different codes", () => {
		const codes = [
			index({doc: DRIFTED}).code,
			index({doc: UNREADABLE}).code,
			index({doc: {_tag: "Text", text: agreeingDoc()}, formats: []}).code,
		];
		expect(new Set(codes).size).toBe(codes.length);
		expect(codes).not.toContain(ANSWER);
		expect(codes).not.toContain(1);
	});
});
