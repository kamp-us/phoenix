import {describe, expect, it} from "vitest";
import {
	foldInteractionProof,
	type InteractionOperand,
	parseInteractionOperands,
	readMatchCount,
	readPseudoProof,
	readVisibleProof,
	stepToken,
} from "./interaction.ts";

const SURFACES = ["/lab/atolye/menu", "/lab/atolye/button:auth"];
const byLabel = (operand: InteractionOperand): string =>
	`${operand.surface}~${operand.interaction.label}`;
const parse = (...operands: string[]) => parseInteractionOperands(operands, SURFACES, byLabel);

describe("parseInteractionOperands", () => {
	it("asks for nothing when no operand was passed", () => {
		expect(parse()).toEqual({_tag: "None"});
	});

	it("reads the surface, the label and every step in order, on a surface carrying a state", () => {
		expect(
			parse(
				'/lab/atolye/menu#sil-highlighted=click:role=button[name="Aç"];hover:role=menuitem[name="Sil"];expect:[role=menuitem][data-highlighted]',
				'/lab/atolye/button:auth#tabbed=press:Tab;focus:role=button[name="Sil"]',
			),
		).toEqual({
			_tag: "Requested",
			operands: [
				{
					surface: "/lab/atolye/menu",
					interaction: {
						label: "sil-highlighted",
						steps: [
							{verb: "click", locator: 'role=button[name="Aç"]'},
							{verb: "hover", locator: 'role=menuitem[name="Sil"]'},
							{verb: "expect", locator: "[role=menuitem][data-highlighted]"},
						],
					},
				},
				{
					surface: "/lab/atolye/button:auth",
					interaction: {
						label: "tabbed",
						steps: [
							{verb: "press", key: "Tab"},
							{verb: "focus", locator: 'role=button[name="Sil"]'},
						],
					},
				},
			],
		});
	});

	it("keeps a locator's own = and # characters, splitting only at the first of each", () => {
		const read = parse('/lab/atolye/menu#x=expect:css=a[href="#top"]');
		expect(read._tag === "Requested" && read.operands[0].interaction.steps).toEqual([
			{verb: "expect", locator: 'css=a[href="#top"]'},
		]);
	});

	it("refuses an unknown step verb, naming the verbs", () => {
		expect(parse("/lab/atolye/menu#x=tap:role=button")).toEqual({
			_tag: "Malformed",
			value: "/lab/atolye/menu#x=tap:role=button",
			reason:
				'step "tap:role=button" names no step verb — the verbs are hover, focus, expect, click, press',
		});
	});

	it("refuses an empty locator or key", () => {
		expect(parse("/lab/atolye/menu#x=hover:")).toMatchObject({
			_tag: "Malformed",
			reason: 'step "hover:" names no locator',
		});
		expect(parse("/lab/atolye/menu#x=press: ;expect:a")).toMatchObject({
			_tag: "Malformed",
			reason: 'step "press: " names no key',
		});
	});

	it("refuses an empty, missing or non-kebab label", () => {
		expect(parse("/lab/atolye/menu#=hover:a")).toMatchObject({reason: "its label is empty"});
		expect(parse("/lab/atolye/menu=hover:a")).toMatchObject({reason: "it names no #<label>"});
		expect(parse("/lab/atolye/menu#Open=hover:a")._tag).toBe("Malformed");
		expect(parse(`/lab/atolye/menu#${"a".repeat(65)}=hover:a`)._tag).toBe("Malformed");
	});

	it("refuses an operand with no steps", () => {
		expect(parse("/lab/atolye/menu#x")).toMatchObject({reason: "it names no steps"});
		expect(parse("/lab/atolye/menu#x=")).toMatchObject({reason: "it names no steps"});
	});

	it("refuses steps that end on a click or a key press — nothing proves what they left", () => {
		expect(parse("/lab/atolye/menu#x=hover:a;click:b")).toMatchObject({
			_tag: "Malformed",
			reason:
				'its steps end on "click:b" with no closing hover, focus, expect step to prove the state the shot records',
		});
		expect(parse("/lab/atolye/menu#x=press:Escape")._tag).toBe("Malformed");
	});

	it("refuses a surface the run did not ask for, including the bare route of a stated surface", () => {
		expect(parse("/lab/atolye/button#x=hover:a")).toEqual({
			_tag: "UnknownSurface",
			value: "/lab/atolye/button#x=hover:a",
			surface: "/lab/atolye/button",
		});
	});

	it("refuses two operands whose shots would share a file name, naming the earlier one", () => {
		expect(parse("/lab/atolye/menu#x=hover:a", "/lab/atolye/menu#x=focus:b")).toEqual({
			_tag: "Collision",
			value: "/lab/atolye/menu#x=focus:b",
			other: "/lab/atolye/menu#x=hover:a",
		});
		expect(parse("/lab/atolye/menu#x=hover:a", "/lab/atolye/menu#y=hover:a")._tag).toBe(
			"Requested",
		);
	});
});

describe("the step proofs", () => {
	const hover = {verb: "hover", locator: 'role=button[name="Sil"]'} as const;
	const focus = {verb: "focus", locator: "#q"} as const;

	it("acts on exactly one element and names any other count", () => {
		expect(readMatchCount(hover, 1)).toBeNull();
		expect(readMatchCount(hover, 3)).toEqual({
			_tag: "Refused",
			reason: 'role=button[name="Sil"] matched 3 elements, not exactly one',
		});
		expect(readMatchCount({verb: "press", key: "Tab"}, 0)).toBeNull();
	});

	it("proves a hover only on :hover and a focus only on :focus-visible", () => {
		expect(readPseudoProof(hover, true)).toEqual({
			_tag: "Proven",
			statement: 'role=button[name="Sil"] matches :hover',
		});
		expect(readPseudoProof(hover, false)).toEqual({
			_tag: "Refused",
			reason: 'role=button[name="Sil"] does not match :hover',
		});
		expect(readPseudoProof(focus, false)).toEqual({
			_tag: "Refused",
			reason: "#q does not match :focus-visible",
		});
		expect(readPseudoProof(focus, null)._tag).toBe("Refused");
	});

	it("proves an expectation only on a visible element", () => {
		const expectStep = {verb: "expect", locator: "[data-highlighted]"} as const;
		expect(readVisibleProof(expectStep, true)).toEqual({
			_tag: "Proven",
			statement: "[data-highlighted] is exactly one visible element",
		});
		expect(readVisibleProof(expectStep, false)._tag).toBe("Refused");
	});

	it("folds the proven statements in order and stops at the first refusal, naming its step", () => {
		const click = {verb: "click", locator: "#open"} as const;
		expect(
			foldInteractionProof([
				{step: click, proof: {_tag: "Acted"}},
				{step: hover, proof: {_tag: "Proven", statement: "a"}},
				{step: focus, proof: {_tag: "Proven", statement: "b"}},
			]),
		).toEqual({_tag: "Proven", proven: ["a", "b"]});
		expect(
			foldInteractionProof([
				{step: click, proof: {_tag: "Refused", reason: "Timeout 5000ms exceeded."}},
			]),
		).toEqual({_tag: "Refused", step: "click:#open", reason: "Timeout 5000ms exceeded."});
	});

	it("prints a step as the token it was parsed from", () => {
		expect(stepToken({verb: "press", key: "Enter"})).toBe("press:Enter");
		expect(stepToken(hover)).toBe('hover:role=button[name="Sil"]');
	});
});
