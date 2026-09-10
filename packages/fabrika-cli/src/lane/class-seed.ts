/**
 * The class seed — the producer `context.<task>.classes` never had.
 *
 * `machine.ts` reads that field to seat {@link TaskState.classes}, the fact a `class:<name>` arm
 * routes on, and until this module nothing in the tree wrote it: the committed template ships
 * `"classes": []`, `lane open` copied it byte-identically, and every class a lane ever carried
 * arrived on an event a head had already raised off a diff. So a rendered-surface lane's *first*
 * build ran in the plain builder — the failure the ui-lane decision record opens by naming.
 *
 * Pure: labels in, seeded document bytes out. Both boot verbs read the same two functions, so the
 * board label and the seeded field cannot mean different things on the two paths.
 *
 * **An off-set spelling refuses here rather than at the compiler.** `machine.ts` also refuses one,
 * but on *read*: a document carrying `"UI"` compiles `Malformed`, and every later fold of that lane
 * refuses with it — a bricked lane rather than a stopped boot. This check is what keeps the bad seed
 * off disk in the first place, and the compile-side one is the backstop for a document that got
 * there another way.
 */

import {classLabel} from "../config/board.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {CLASSES} from "../triage/facets.ts";

/**
 * The classes an issue's labels declare, in {@link CLASSES} order.
 *
 * Every `class:` label is reported, including one outside the set: reading it as absent would let a
 * misspelled label boot a lane that silently routes as unclassed, which is the whole defect. The
 * caller decides — {@link seedClasses} refuses it.
 */
export const classesFromLabels = (labels: ReadonlyArray<string>): ReadonlyArray<string> => {
	const declared = labels.flatMap((label) =>
		label.startsWith("class:") ? [label.slice("class:".length)] : [],
	);
	const known = CLASSES.filter((name) => declared.includes(name));
	return [...known, ...declared.filter((name) => !CLASSES.includes(name))];
};

/**
 * The declared names outside {@link CLASSES}, in the order they were declared.
 *
 * One reader for the whole seed side, so `lane open`'s pre-placement refusal, `lane emit`'s and
 * {@link seedClasses}'s own cannot disagree about which spelling is off the set.
 */
export const offSetClasses = (classes: ReadonlyArray<string>): ReadonlyArray<string> =>
	classes.filter((name) => !CLASSES.includes(name));

export type Seed =
	| {readonly _tag: "Seeded"; readonly text: string; readonly classes: ReadonlyArray<string>}
	/** The document was copied through untouched — no class stands, so the bytes are the template's. */
	| {readonly _tag: "Unchanged"; readonly text: string}
	| {readonly _tag: "OffSet"; readonly names: ReadonlyArray<string>}
	| {readonly _tag: "Unseedable"; readonly reason: string};

/**
 * Seed every task's `context.<task>.classes` in one machine document's bytes.
 *
 * Every context entry rather than a named task, because which task a template calls its own is the
 * template's business: the coder template has exactly one, `issue`, so this writes
 * `context.issue.classes` there and nothing else. A document whose context is empty declares no task
 * to seed and comes back `Unseedable` rather than silently placed unclassed.
 *
 * An empty class set returns the input text unchanged, so `lane open` still places the committed
 * template byte-identically whenever no class stands.
 */
export const seedClasses = (text: string, classes: ReadonlyArray<string>): Seed => {
	const offSet = offSetClasses(classes);
	if (offSet.length > 0) return {_tag: "OffSet", names: offSet};
	if (classes.length === 0) return {_tag: "Unchanged", text};

	const document = parseJson(text);
	if (!isRecord(document)) return {_tag: "Unseedable", reason: "the document is not JSON"};
	const machine = document.machine;
	if (!isRecord(machine) || !isRecord(machine.context)) {
		return {_tag: "Unseedable", reason: "the document carries no `machine.context` object"};
	}
	const tasks = Object.keys(machine.context);
	if (tasks.length === 0) {
		return {_tag: "Unseedable", reason: "the document's `machine.context` declares no task"};
	}
	const context = Object.fromEntries(
		tasks.map((task) => {
			const entry = machine.context as Record<string, unknown>;
			const seat = entry[task];
			return [task, {...(isRecord(seat) ? seat : {}), classes: [...classes]}];
		}),
	);
	const seeded = {...document, machine: {...machine, context}};
	return {_tag: "Seeded", text: `${JSON.stringify(seeded, null, "\t")}\n`, classes};
};

/** The class names, as the `class:<name>` labels a refusal quotes back. */
export const renderClasses = (names: ReadonlyArray<string>): string =>
	names.map(classLabel).join(", ");
