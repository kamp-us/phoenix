/**
 * Shoot a surface in an interaction state — hovered, focused, a menu opened, a toast raised — and
 * prove the page reached it. Pure — no browser; `capture.ts` drives each step on the shot's page and
 * hands what the page reported back to the readers here.
 *
 * An interaction is its own operand, not a `:state` token: `states.ts` keeps `:state` a closed list
 * of seeded sessions, and a hover is a thing done to a page after it loads, not an identity it loads
 * as. Every step that claims a state owes a proof read off the page, for the reason a `:state` owes
 * one: a hover the page never registered paints the at-rest pixels, a valid PNG under the
 * interacted name.
 * @ruling https://github.com/kamp-us/phoenix/issues/7051
 */

/** Steps that leave a state the page can be asked about, so each one is proved where it runs. */
export const PROVING_VERBS = ["hover", "focus", "expect"] as const;
export type ProvingVerb = (typeof PROVING_VERBS)[number];

/** Steps that only act. A shot cannot end on one, because nothing would prove what it left. */
export const ACTING_VERBS = ["click", "press"] as const;
export type ActingVerb = (typeof ACTING_VERBS)[number];

export const STEP_VERBS = [...PROVING_VERBS, ...ACTING_VERBS] as const;

export interface ProvingStep {
	readonly verb: ProvingVerb;
	/** A Playwright selector, role and accessible name first (`role=button[name="Sil"]`). */
	readonly locator: string;
}

export type ActingStep =
	| {readonly verb: "click"; readonly locator: string}
	| {readonly verb: "press"; readonly key: string};

export type InteractionStep = ProvingStep | ActingStep;

/**
 * The steps a shot runs after navigation, in order. The last one proves: a run ending on a click or
 * a key press would record whatever the page drew next with nothing checked about it.
 */
export type InteractionSteps = readonly [...InteractionStep[], ProvingStep];

export interface Interaction {
	/** Names the shot — in its PNG, its manifest entry, its gallery heading and its stderr lines. */
	readonly label: string;
	readonly steps: InteractionSteps;
}

/** One `--interact` operand: the surface it runs on, and what it does there. */
export interface InteractionOperand {
	readonly surface: string;
	readonly interaction: Interaction;
}

/** What the page is asked to match after a hover or a focus. */
export const PSEUDO_CLASS = {hover: ":hover", focus: ":focus-visible"} as const;

const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A label is a file-name segment, so it is bounded the way the route stem is. */
export const MAX_LABEL = 64;

export const stepToken = (step: InteractionStep): string =>
	step.verb === "press" ? `press:${step.key}` : `${step.verb}:${step.locator}`;

const isProvingVerb = (verb: string): verb is ProvingVerb =>
	(PROVING_VERBS as readonly string[]).includes(verb);

const isProvingStep = (step: InteractionStep): step is ProvingStep => isProvingVerb(step.verb);

type StepRead =
	| {readonly _tag: "Step"; readonly step: InteractionStep}
	| {readonly _tag: "Malformed"; readonly reason: string};

const parseStep = (token: string): StepRead => {
	const colon = token.indexOf(":");
	const verb = colon === -1 ? token : token.slice(0, colon);
	const operand = colon === -1 ? "" : token.slice(colon + 1);
	if (!(STEP_VERBS as readonly string[]).includes(verb)) {
		return {
			_tag: "Malformed",
			reason: `step "${token}" names no step verb — the verbs are ${STEP_VERBS.join(", ")}`,
		};
	}
	if (operand.trim().length === 0) {
		return {
			_tag: "Malformed",
			reason: `step "${token}" names no ${verb === "press" ? "key" : "locator"}`,
		};
	}
	if (verb === "press") return {_tag: "Step", step: {verb, key: operand}};
	if (verb === "click") return {_tag: "Step", step: {verb, locator: operand}};
	return {_tag: "Step", step: {verb: verb as ProvingVerb, locator: operand}};
};

type OperandRead =
	| {readonly _tag: "Operand"; readonly operand: InteractionOperand}
	| {readonly _tag: "Malformed"; readonly reason: string};

/**
 * `<surface>#<label>=<step>;<step>;…`. The surface is read up to the first `#` and the label up to
 * the first `=` after it, so a locator may carry either character; a step cannot carry `;`.
 */
const parseOperand = (raw: string): OperandRead => {
	const hash = raw.indexOf("#");
	if (hash === -1) {
		return {_tag: "Malformed", reason: "it names no #<label>"};
	}
	const surface = raw.slice(0, hash);
	if (surface.length === 0) return {_tag: "Malformed", reason: "it names no surface"};
	const rest = raw.slice(hash + 1);
	const equals = rest.indexOf("=");
	const label = equals === -1 ? rest : rest.slice(0, equals);
	if (label.length === 0) return {_tag: "Malformed", reason: "its label is empty"};
	if (!LABEL.test(label) || label.length > MAX_LABEL) {
		return {
			_tag: "Malformed",
			reason: `its label "${label}" is not kebab-case [a-z0-9-] of at most ${MAX_LABEL} characters`,
		};
	}
	const tokens = equals === -1 ? [] : rest.slice(equals + 1).split(";");
	if (tokens.every((token) => token.length === 0)) {
		return {_tag: "Malformed", reason: "it names no steps"};
	}
	const steps: InteractionStep[] = [];
	for (const token of tokens) {
		const read = parseStep(token);
		if (read._tag === "Malformed") return read;
		steps.push(read.step);
	}
	const last = steps.at(-1);
	if (last === undefined || !isProvingStep(last)) {
		return {
			_tag: "Malformed",
			reason: `its steps end on "${last === undefined ? "" : stepToken(last)}" with no closing ${PROVING_VERBS.join(", ")} step to prove the state the shot records`,
		};
	}
	return {
		_tag: "Operand",
		operand: {
			surface,
			interaction: {label, steps: [...steps.slice(0, -1), last]},
		},
	};
};

/**
 * No operand shoots every surface at rest exactly as before. The refusing arms are refused before a
 * browser launches: a malformed operand has nothing to run, an operand on a surface the run did not
 * ask for has no shot to hang off, and two operands whose shots share a PNG name would overwrite
 * one another's file and evidence.
 */
export type InteractionOperandsRead =
	| {readonly _tag: "None"}
	| {
			readonly _tag: "Requested";
			readonly operands: readonly [InteractionOperand, ...InteractionOperand[]];
	  }
	| {readonly _tag: "Malformed"; readonly value: string; readonly reason: string}
	| {readonly _tag: "UnknownSurface"; readonly value: string; readonly surface: string}
	| {readonly _tag: "Collision"; readonly value: string; readonly other: string};

/**
 * @param surfaces the run's own `--surface` tokens — an operand must name one of them exactly.
 * @param fileNameOf the PNG name an operand's shot would take, so a collision is judged on the name
 *   the files would actually carry rather than on the operand text.
 */
export const parseInteractionOperands = (
	operands: readonly string[],
	surfaces: readonly string[],
	fileNameOf: (operand: InteractionOperand) => string,
): InteractionOperandsRead => {
	const parsed: Array<{readonly raw: string; readonly operand: InteractionOperand}> = [];
	for (const raw of operands) {
		const read = parseOperand(raw);
		if (read._tag === "Malformed") return {_tag: "Malformed", value: raw, reason: read.reason};
		if (!surfaces.includes(read.operand.surface)) {
			return {_tag: "UnknownSurface", value: raw, surface: read.operand.surface};
		}
		const name = fileNameOf(read.operand);
		const other = parsed.find((earlier) => fileNameOf(earlier.operand) === name);
		if (other !== undefined) return {_tag: "Collision", value: raw, other: other.raw};
		parsed.push({raw, operand: read.operand});
	}
	const [first, ...rest] = parsed.map((entry) => entry.operand);
	return first === undefined ? {_tag: "None"} : {_tag: "Requested", operands: [first, ...rest]};
};

/**
 * One step's answer off the page. A proving step answers with the sentence it proved; an acting step
 * answers `Acted`, because it claims nothing.
 */
export type StepProof =
	| {readonly _tag: "Proven"; readonly statement: string}
	| {readonly _tag: "Acted"}
	| {readonly _tag: "Refused"; readonly reason: string};

/** A locator step acts on exactly one element; zero or several is no element the step could name. */
export const readMatchCount = (step: InteractionStep, count: number): StepProof | null => {
	if (step.verb === "press" || count === 1) return null;
	return {
		_tag: "Refused",
		reason: `${step.locator} matched ${count} elements, not exactly one`,
	};
};

/** Whether the element a hover or focus step named reports its pseudo-class. */
export const readPseudoProof = (
	step: ProvingStep & {readonly verb: "hover" | "focus"},
	matched: unknown,
): StepProof => {
	const pseudo = PSEUDO_CLASS[step.verb];
	if (typeof matched !== "boolean") {
		return {_tag: "Refused", reason: `${step.locator}'s ${pseudo} match did not read back`};
	}
	return matched
		? {_tag: "Proven", statement: `${step.locator} matches ${pseudo}`}
		: {_tag: "Refused", reason: `${step.locator} does not match ${pseudo}`};
};

/** Whether the one element an expect step named is visible. */
export const readVisibleProof = (step: ProvingStep, visible: unknown): StepProof =>
	visible === true
		? {_tag: "Proven", statement: `${step.locator} is exactly one visible element`}
		: {_tag: "Refused", reason: `${step.locator} is not visible`};

/**
 * A whole interaction's answer. `Refused` names the step that stopped it, and the shot is never
 * taken: the page past a failed step is not the state the label names.
 */
export interface InteractionProven {
	readonly _tag: "Proven";
	readonly proven: readonly [string, ...string[]];
}
export interface InteractionRefused {
	readonly _tag: "Refused";
	readonly step: string;
	readonly reason: string;
}
export type InteractionProof = InteractionProven | InteractionRefused;

/** Fold the steps' answers, in order, stopping at the first refusal. */
export const foldInteractionProof = (
	answers: ReadonlyArray<{readonly step: InteractionStep; readonly proof: StepProof}>,
): InteractionProof => {
	const proven: string[] = [];
	for (const {step, proof} of answers) {
		if (proof._tag === "Refused") {
			return {_tag: "Refused", step: stepToken(step), reason: proof.reason};
		}
		if (proof._tag === "Proven") proven.push(proof.statement);
	}
	const [first, ...rest] = proven;
	return first === undefined
		? {_tag: "Refused", step: "", reason: "no step proved anything"}
		: {_tag: "Proven", proven: [first, ...rest]};
};
