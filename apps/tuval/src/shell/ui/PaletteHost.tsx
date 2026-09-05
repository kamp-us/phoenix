/**
 * The palette, wired to this desk. `../../palette/` is the surface; what this adds is the two things
 * it deliberately does not own — the registry it completes against, and what a `SpellCall` does.
 *
 * **Both are read off the shell's own command table** (`../commands/table.ts`), the same rows the
 * `:` line reads and the shell program publishes as spells, so a path the palette offers is a path
 * the command line accepts and a binding can name (ADR 0348, `.patterns/tuval-spells.md`). There is
 * no second command mechanism here, and no second dispatch.
 *
 * **The reply is synthesised on the page, not awaited from the kernel.** The page-to-kernel spell
 * transport is a sibling ticket; until it lands, a call is decoded against the row's real `params`
 * and its Msg dispatched, which is exactly what `readCommandLine` does with a typed line. That
 * makes the refusals real — a bad argument is the row's own schema refusing it — and leaves the
 * palette's own contract (`onCall` out, `reply` in) untouched when the transport arrives.
 */

import {Result, Schema} from "effect";
import type {ReactElement} from "react";
import {useCallback, useMemo, useState} from "react";
import {buildSpellIndex} from "../../commands/parse/spell-index.ts";
import {Palette} from "../../palette/index.ts";
import type {LayoutNode} from "../../protocol/desk.ts";
import {type CallId, WindowId} from "../../protocol/ids.ts";
import {firstSchemaIssue} from "../../protocol/issue.ts";
import type {SpellCall, SpellReply} from "../../protocol/messages.ts";
import {
	PROTOCOL_VERSION,
	Snapshot,
	SpellReplyError,
	SpellReplyOk,
} from "../../protocol/messages.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {commandFor, shellCommands} from "../commands/table.ts";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {activeWorkspace} from "../core/index.ts";
import type {LayoutNode as ShellLayoutNode} from "../layout/index.ts";

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

const refusal = (id: CallId, message: string, path: SpellCall["path"]): SpellReply =>
	new SpellReplyError({
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id,
		ok: false,
		error: {tag: "tuval/BadArgs", message, path},
	});

export interface PaletteHostProps {
	readonly state: ShellState;
	readonly dispatch: (msg: ShellMsg) => void;
	/** The window focused when the palette opened — the call's scope, never the layout's. */
	readonly window: WindowId | undefined;
	readonly onClose: () => void;
}

export function PaletteHost({state, dispatch, window, onClose}: PaletteHostProps): ReactElement {
	const [reply, setReply] = useState<SpellReply | null>(null);
	const snapshot = useMemo(() => asSnapshot(state), [state]);

	const onCall = useCallback(
		(call: SpellCall) => {
			const command = commandFor(call.path.join(":"));
			if (command === undefined) {
				setReply(refusal(call.id, "this desk registers no spell at that path", call.path));
				return;
			}
			const decoded = Schema.decodeUnknownResult(command.params)(call.args);
			if (Result.isFailure(decoded)) {
				const {expected, at} = firstSchemaIssue(decoded.failure);
				setReply(
					refusal(call.id, `${at === "" ? "the argument" : at} should be ${expected}`, call.path),
				);
				return;
			}
			dispatch(command.toMsg(decoded.success));
			setReply(
				new SpellReplyOk({
					type: "spell.reply",
					version: PROTOCOL_VERSION,
					id: call.id,
					ok: true,
					result: {},
				}),
			);
		},
		[dispatch],
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
