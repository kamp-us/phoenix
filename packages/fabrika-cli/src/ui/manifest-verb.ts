/**
 * `ui manifest` — the repo's design surfaces, by convention: presence and paths, no judgment.
 *
 * The manifest is the one surface whose absence refuses, and it refuses on `12` rather than the
 * generic zero-scope `7`: an un-bootstrapped repo is a *routable* state with a named next step
 * (front-door's bootstrap, #4952), not an absence to report. Everything else reports `null`, because
 * "this repo ships no inventory" is a fact a skill acts on.
 *
 * A probe that could not be *performed* is `11`. Presence is UNKNOWN, never "absent" — `node:fs`'s
 * `existsSync` reports an unreadable parent directory as absent, which is how a missing law comes to
 * look like a repo that never had one.
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {exists} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {NO_MANIFEST, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	atRoot,
	GOLDEN_POINTER_PATHS,
	HARNESS_PATH,
	INVENTORY_PATH,
	MANIFEST_PATH,
	REGISTRY_PATH,
} from "./conventions.ts";
import {resolveRoot} from "./lane.ts";

const VERB = "ui manifest";

export type Probe =
	| {readonly _tag: "Present"; readonly relative: string}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Unknown"; readonly relative: string; readonly reason: string};

/** Probe one convention path. A read fault is its own outcome, never folded into "absent". */
export const probe = (
	root: string,
	relative: string,
): Effect.Effect<Probe, never, FileSystem.FileSystem> =>
	exists(atRoot(root, relative)).pipe(
		Effect.map((found): Probe => (found ? {_tag: "Present", relative} : {_tag: "Absent"})),
		Effect.catchTag("fabrika-cli/ReadFailed", (cause) =>
			Effect.succeed<Probe>({_tag: "Unknown", relative, reason: cause.reason}),
		),
	);

/** The first present path of a probe order, or the absence/unknown that decided it. */
const probeOrder = (
	root: string,
	relatives: ReadonlyArray<string>,
): Effect.Effect<Probe, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		for (const relative of relatives) {
			const found = yield* probe(root, relative);
			if (found._tag !== "Absent") return found;
		}
		return {_tag: "Absent"} as const;
	});

const unreadable = (found: Probe & {_tag: "Unknown"}, verb: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`${verb}: cannot probe ${found.relative}: ${found.reason} — presence is UNKNOWN, never "absent".`,
	);

export const MISSING_MANIFEST = `${VERB}: no design manifest at ${MANIFEST_PATH} — this repo is not set up for UI construction. Run /fabrika: front-door's bootstrap drafts one from the repo's own CSS and pages (#4952). Never improvise a design language.`;

export const runManifest = (): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const root = yield* resolveRoot(VERB);
		if (root._tag === "Refused") return root.outcome;

		const manifest = yield* probe(root.root, MANIFEST_PATH);
		if (manifest._tag === "Unknown") return unreadable(manifest, VERB);
		if (manifest._tag === "Absent") return refuse(NO_MANIFEST, MISSING_MANIFEST);

		const registry = yield* probe(root.root, REGISTRY_PATH);
		if (registry._tag === "Unknown") return unreadable(registry, VERB);
		const inventory = yield* probe(root.root, INVENTORY_PATH);
		if (inventory._tag === "Unknown") return unreadable(inventory, VERB);
		const pointer = yield* probeOrder(root.root, GOLDEN_POINTER_PATHS);
		if (pointer._tag === "Unknown") return unreadable(pointer, VERB);
		const harness = yield* probe(root.root, HARNESS_PATH);
		if (harness._tag === "Unknown") return unreadable(harness, VERB);

		const pathOf = (found: Probe): string | null =>
			found._tag === "Present" ? found.relative : null;
		return answer(
			JSON.stringify({
				manifest: MANIFEST_PATH,
				registry: pathOf(registry),
				inventory: pathOf(inventory),
				goldenPointer: pathOf(pointer),
				harness: pathOf(harness),
				lawSource: registry._tag === "Present" ? "registry" : "manifest-prose",
			}),
			[`${VERB}: probed 5 convention paths against ${root.root}.`],
		);
	});
