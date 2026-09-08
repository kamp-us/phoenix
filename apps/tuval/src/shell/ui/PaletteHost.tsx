/**
 * The palette, wired to this desk. `../../palette/` is the surface; what this adds is the two things
 * it deliberately does not own — the registry it completes against, and what a `SpellCall` does.
 *
 * **Both are read off the shell's own command table** (`../commands/table.ts`), the same rows the
 * `:` line reads and the shell program publishes as spells, so a path the palette offers is a path
 * the command line accepts and a binding can name (ADR 0348, `.patterns/tuval-spells.md`). There is
 * no second command mechanism here, and no second dispatch.
 *
 * **The reply is the kernel's** (#8161). A call goes down this page's socket and the executor's
 * answer is what the palette renders, so a bad argument is refused by the row's own schema in the
 * kernel and a run is the kernel's dispatch — there is no second decode and no second refusal shape
 * living here. The kernel registers a shell row's spells under `[shell, ...path]`
 * (`../commands/spells.ts`), which is the one translation this module makes; a path the shell table
 * does not hold is not a path the kernel holds either, and that is the one refusal still written
 * here.
 */

import {Effect, Schema} from "effect";
import type {ReactElement} from "react";
import {useCallback, useMemo, useState} from "react";
import {buildSpellIndex} from "../../commands/parse/spell-index.ts";
import {Palette} from "../../palette/index.ts";
import {WindowId} from "../../protocol/ids.ts";
import type {SpellReply} from "../../protocol/messages.ts";
import {PROTOCOL_VERSION, SpellCall, SpellReplyError} from "../../protocol/messages.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {commandFor, shellCommands} from "../commands/table.ts";
import type {ShellState} from "../core/index.ts";
import {activeWorkspace} from "../core/index.ts";
import {type PageAttachment, SHELL_PROGRAM_ID} from "../transport/browser.ts";
import {commandSnapshot} from "./command-snapshot.ts";

/** Every shell row as the wire describes a spell. Built once: the table is a module constant. */
const descriptions: RegistryDescription = shellCommands.map((command) => ({
	path: [...command.path],
	describe: command.describe,
	params: Schema.toJsonSchemaDocument(command.params),
	capabilities: [],
}));

const registry = buildSpellIndex(descriptions);

const refusal = (call: SpellCall, tag: string, message: string): SpellReply =>
	new SpellReplyError({
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id: call.id,
		ok: false,
		error: {tag, message, path: call.path},
	});

/** The same call, addressed as the kernel registers it: a shell row's spells sit under its program id. */
const onTheRegistry = (call: SpellCall): SpellCall =>
	new SpellCall({...call, path: [SHELL_PROGRAM_ID, ...call.path]});

export interface PaletteHostProps {
	readonly state: ShellState;
	/**
	 * This page's socket. A surface with no socket behind it — a fixture, a story — passes none, and
	 * every call is refused rather than answered by a reply the page made up.
	 */
	readonly call?: PageAttachment["call"];
	/** The window focused when the palette opened — the call's scope, never the layout's. */
	readonly window: WindowId | undefined;
	readonly onClose: () => void;
}

export function PaletteHost({state, call, window, onClose}: PaletteHostProps): ReactElement {
	const [reply, setReply] = useState<SpellReply | null>(null);
	const snapshot = useMemo(() => commandSnapshot(state, descriptions), [state]);

	const onCall = useCallback(
		(spell: SpellCall) => {
			if (commandFor(spell.path.join(":")) === undefined) {
				setReply(refusal(spell, "tuval/UnknownSpell", "this desk registers no spell at that path"));
				return;
			}
			if (call === undefined) {
				setReply(refusal(spell, "tuval/NoKernel", "this surface has no kernel to call"));
				return;
			}
			Effect.runFork(
				call(onTheRegistry(spell)).pipe(
					Effect.flatMap((answer) => Effect.sync(() => setReply(answer))),
					Effect.catchCause(() =>
						Effect.sync(() =>
							setReply(refusal(spell, "tuval/SocketGone", "the desk lost its link to the kernel")),
						),
					),
				),
			);
		},
		[call],
	);

	return (
		<Palette
			snapshot={snapshot}
			registry={registry}
			window={window}
			reply={reply}
			onCall={onCall}
			onClose={onClose}
		/>
	);
}

/** The window a call opened from, when the desk has one focused. */
export const focusedWindowOf = (state: ShellState): WindowId | undefined => {
	const focused = activeWorkspace(state)?.focused;
	return focused === undefined ? undefined : WindowId.make(focused);
};
