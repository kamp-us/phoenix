/**
 * What the picker's "Open project…" asks the kernel for (#9697, ruling #9668 R6.1), as one port: the
 * recent folders, a folder's subfolders, and the open itself. The page answers it with `project`
 * spell calls over its own socket, so an open takes exactly the path `tuval open` takes
 * (`../../discovery/reach.ts`), trust prompt included; the proof page answers it from fixtures.
 */

import {CallId} from "@kampus/tuval-sdk/kernel/protocol/ids";
import {
	PROTOCOL_VERSION,
	SpellCall,
	type SpellReply,
} from "@kampus/tuval-sdk/kernel/protocol/messages";
import {Effect, Schema} from "effect";
import {
	FolderListing,
	OpenedProject,
	type RecentProjectRow,
	RecentProjects,
} from "../../projects/open-project-wire.ts";

/** Why the kernel did not answer as asked: its own message, or the socket's. */
export class ProjectOpenerFailure extends Schema.TaggedError<ProjectOpenerFailure>()(
	"tuval/ProjectOpenerFailure",
	{reason: Schema.String},
) {
	override get message(): string {
		return this.reason;
	}
}

export interface ProjectOpener {
	readonly recent: Effect.Effect<ReadonlyArray<RecentProjectRow>, ProjectOpenerFailure>;
	/** `null` browses the desk's home folder. */
	readonly browse: (folder: string | null) => Effect.Effect<FolderListing, ProjectOpenerFailure>;
	/** Resolves once the folder is open, which waits on the trust prompt when it asks one. */
	readonly open: (folder: string) => Effect.Effect<OpenedProject, ProjectOpenerFailure>;
}

type Call = (spell: SpellCall) => Effect.Effect<SpellReply, {readonly message: string}>;

/** The port over a page's spell call. */
export const projectOpenerOver = (call: Call): ProjectOpener => {
	// Suspended, so each run mints its own call id: a reply is matched to its call by that id.
	const ask = <A>(verb: string, args: object, result: Schema.Decoder<A>) =>
		Effect.suspend(() =>
			call(
				new SpellCall({
					type: "spell.call",
					version: PROTOCOL_VERSION,
					id: CallId.make(crypto.randomUUID()),
					path: ["project", verb],
					args,
				}),
			).pipe(
				Effect.mapError((error) => new ProjectOpenerFailure({reason: error.message})),
				Effect.flatMap((reply) =>
					reply.ok
						? Schema.decodeUnknownEffect(result)(reply.result).pipe(
								Effect.mapError(
									() =>
										new ProjectOpenerFailure({
											reason: `the desk answered project ${verb} in a shape this page cannot read`,
										}),
								),
							)
						: Effect.fail(new ProjectOpenerFailure({reason: reply.error.message})),
				),
			),
		);
	return {
		recent: ask("recent", {}, RecentProjects),
		browse: (folder) => ask("browse", folder === null ? {} : {folder}, FolderListing),
		open: (folder) => ask("open", {folder}, OpenedProject),
	};
};
