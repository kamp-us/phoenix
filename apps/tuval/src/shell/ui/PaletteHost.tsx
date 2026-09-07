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
import type {LayoutNode} from "../../protocol/desk.ts";
import {WindowId} from "../../protocol/ids.ts";
import type {SpellReply} from "../../protocol/messages.ts";
import {PROTOCOL_VERSION, Snapshot, SpellCall, SpellReplyError} from "../../protocol/messages.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {commandFor, shellCommands} from "../commands/table.ts";
import type {ShellState} from "../core/index.ts";
import {activeWorkspace} from "../core/index.ts";
import type {LayoutNode as ShellLayoutNode} from "../layout/index.ts";
import {type PageAttachment, SHELL_PROGRAM_ID} from "../transport/browser.ts";

/** Every shell row as the wire describes a spell. Built once: the table is a module constant. */
const descriptions: RegistryDescription = shellCommands.map((command) => ({
	path: [...command.path],
	describe: command.describe,
	params: Schema.toJsonSchemaDocument(command.params),
	capabilities: [],
}));

const registry = buildSpellIndex(descriptions);

/**
 * The shell's layout tree as the protocol spells it. The vocabulary differs by one word on each
 * side — the shell says `horizontal` for children sitting side by side, the wire says `row` — and
 * this is the only place the two meet (`.glossary/LANGUAGE.md`, "Tuval: stack, orientation…").
 */
const asLayout = (node: ShellLayoutNode): LayoutNode =>
	node.tag === "window"
		? {kind: "leaf", window: WindowId.make(node.id)}
		: {
				kind: "split",
				orientation: node.orientation === "horizontal" ? "row" : "column",
				children: node.children.map(asLayout),
			};

/**
 * The desk as a `Snapshot`. The kernel does not send one yet, so the page builds it off the state it
 * does hold: the completion engine reads the workspace names, the window ids and the process rows
 * out of it and nothing else, and every one of those is here.
 */
const asSnapshot = (state: ShellState): Snapshot => {
	const windows: Record<string, {readonly id: WindowId; readonly recency: number}> = {};
	const workspaces: Record<string, unknown> = {};
	let recency = 0;
	for (const workspaceId of state.order) {
		const workspace = state.workspaces[workspaceId];
		if (workspace === undefined) continue;
		workspaces[workspaceId] = {
			id: workspaceId,
			// The shell's workspaces carry an id and no name; the id is what a founder types.
			name: workspaceId,
			layout: asLayout(workspace.layout.root),
			focused: WindowId.make(workspace.focused),
		};
		for (const window of collectWindows(workspace.layout.root)) {
			recency += 1;
			windows[window] = {id: WindowId.make(window), recency};
		}
	}
	return new Snapshot({
		type: "snapshot",
		version: PROTOCOL_VERSION,
		rev: 0,
		desk: {workspaces, activeWorkspace: state.activeWorkspace} as Snapshot["desk"],
		windows: windows as Snapshot["windows"],
		processes: [],
		registry: descriptions,
	});
};

const collectWindows = (node: ShellLayoutNode): ReadonlyArray<string> =>
	node.tag === "window" ? [node.id] : node.children.flatMap(collectWindows);

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
	const snapshot = useMemo(() => asSnapshot(state), [state]);

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
