/**
 * The one-time move of the desk's own saved state out of a project's state directory (#9977). Until
 * the desk had a state directory of its own it shared its boot folder's, so the shell and every
 * global process a desk ran were checkpointed beside that project's, and its Pi sessions were kept
 * there too. Left alone they would never come back: the desk restores from its own directory, and a
 * project restores only what it owns.
 *
 * So a boot moves what it finds in the folder it opens first. An entry no project owns
 * (`processScope`) has its snapshot written into the desk's store before it is deleted from the
 * project's, and each manifest is written after its snapshots. An entry the desk's manifest already
 * names stays where it is, and so do Pi sessions when the desk already keeps some: the desk that
 * wrote the desk's copy is the live one, and destroying either copy is not this move's call.
 */

import type {Store} from "@demlik/tea";
import {
	type Manifest,
	type ManifestEntry,
	parseManifest,
	parseSnapshot,
} from "@kampus/tuval-sdk/kernel/durability/snapshot";
import {fileStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {piSessionStore} from "@kampus/tuval-sdk/kernel/state-dir";
import {Effect, FileSystem, Schema} from "effect";
import {processScope} from "../project-id.ts";

export class DeskStateLiftFailed extends Schema.TaggedError<DeskStateLiftFailed>()(
	"tuval/DeskStateLiftFailed",
	{from: Schema.String, reason: Schema.String},
) {
	override get message(): string {
		return `could not move the desk's state out of ${this.from}: ${this.reason}`;
	}
}

/** What one boot's move took, and what it left because the desk already holds one. */
export interface DeskStateLifted {
	/** Process ids moved into the desk's directory, then `pi-sessions` when the sessions moved. */
	readonly moved: ReadonlyArray<string>;
	/** Process ids, and `pi-sessions`, left in the project because the desk already has its own. */
	readonly kept: ReadonlyArray<string>;
}

const nothingLifted: DeskStateLifted = {moved: [], kept: []};

const PI_SESSIONS = "pi-sessions";

export const liftDeskState = Effect.fn("Tuval.liftDeskState")(function* (from: string, to: string) {
	if (from === to) return nothingLifted;
	const fs = yield* FileSystem.FileSystem;
	const fail = (reason: string) => new DeskStateLiftFailed({from, reason});
	const attempt = <A>(what: string, run: () => Promise<A>) =>
		Effect.tryPromise({try: run, catch: (cause) => fail(`${what}: ${String(cause)}`)});
	const manifestOf = (store: Store<Manifest>, what: string) =>
		Effect.map(
			attempt(`reading ${what}`, () => store.load()),
			(raw) => (raw === null ? ({processes: []} satisfies Manifest) : parseManifest(raw)),
		);

	const source = fileStores(from);
	const target = fileStores(to);
	const theirs = yield* manifestOf(source.manifest, "the project's manifest");
	const ours = yield* manifestOf(target.manifest, "the desk's manifest");
	const moved: Array<string> = [];
	const kept: Array<string> = [];
	// A manifest that does not parse is `Checkpoints`' refusal to make, not this move's: both are
	// left as they are, so the boot refuses where it always has.
	if (theirs !== null && ours !== null) {
		const named = new Set(ours.processes.map((entry) => entry.id));
		const lifted: Array<ManifestEntry> = [];
		for (const entry of theirs.processes) {
			if (processScope(entry) !== undefined) continue;
			if (named.has(entry.id)) {
				kept.push(entry.id);
				continue;
			}
			const id = ProcessId.make(entry.id);
			const snapshot = parseSnapshot(
				yield* attempt(`reading ${entry.id}`, () => source.snapshot(id).load()),
			);
			if (snapshot !== null) {
				yield* attempt(`writing ${entry.id}`, () => target.snapshot(id).save(snapshot));
			}
			lifted.push(entry);
			moved.push(entry.id);
		}
		if (lifted.length > 0) {
			yield* attempt("writing the desk's manifest", () =>
				target.manifest.save({processes: [...ours.processes, ...lifted]}),
			);
			yield* attempt("writing the project's manifest", () =>
				source.manifest.save({
					processes: theirs.processes.filter((entry) => !lifted.includes(entry)),
				}),
			);
			for (const entry of lifted) {
				yield* attempt(`deleting ${entry.id}`, () =>
					source.snapshot(ProcessId.make(entry.id)).delete(),
				);
			}
		}
	}

	const sessions = piSessionStore(from);
	if (yield* fs.exists(sessions).pipe(Effect.mapError((error) => fail(error.message)))) {
		const into = piSessionStore(to);
		if (yield* fs.exists(into).pipe(Effect.mapError((error) => fail(error.message)))) {
			kept.push(PI_SESSIONS);
		} else {
			yield* fs
				.rename(sessions, into)
				.pipe(Effect.mapError((error) => fail(`moving ${PI_SESSIONS}: ${error.message}`)));
			moved.push(PI_SESSIONS);
		}
	}
	return {moved, kept} satisfies DeskStateLifted;
});

/** The boot lines one move owes the operator, unprefixed: what moved, and what a collision left. */
export const renderDeskStateLift = (
	lifted: DeskStateLifted,
	from: string,
	to: string,
): ReadonlyArray<string> => [
	...(lifted.moved.length === 0
		? []
		: [`moved the desk's ${lifted.moved.join(", ")} out of ${from} into ${to}`]),
	...(lifted.kept.length === 0
		? []
		: [`left the desk's ${lifted.kept.join(", ")} in ${from} — ${to} already holds its own`]),
];
