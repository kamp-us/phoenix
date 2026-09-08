/** Live registry commands and shell shortcuts, calling the attached kernel. */

import {Effect, Fiber, Schema} from "effect";
import type {ReactElement} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {buildSpellIndex} from "../../commands/parse/spell-index.ts";
import {Palette} from "../../palette/index.ts";
import {WindowId} from "../../protocol/ids.ts";
import type {SpellReply} from "../../protocol/messages.ts";
import {PROTOCOL_VERSION, SpellCall, SpellReplyError} from "../../protocol/messages.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {shellCommands} from "../commands/table.ts";
import type {ShellState} from "../core/index.ts";
import {activeWorkspace} from "../core/index.ts";
import {type PageAttachment, SHELL_PROGRAM_ID} from "../transport/browser.ts";
import {commandSnapshot} from "./command-snapshot.ts";

/** Every shell row as the wire describes a spell. Built once: the table is a module constant. */
const shellDescriptions: RegistryDescription = shellCommands.map((command) => ({
	path: [...command.path],
	describe: command.describe,
	params: Schema.toJsonSchemaDocument(command.params),
	capabilities: [],
}));

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
	readonly registry?: RegistryDescription | undefined;
	/**
	 * This page's socket. A surface with no socket behind it — a fixture, a story — passes none, and
	 * every call is refused rather than answered by a reply the page made up.
	 */
	readonly call?: PageAttachment["call"];
	/** The window focused when the palette opened — the call's scope, never the layout's. */
	readonly window: WindowId | undefined;
	readonly onClose: () => void;
}

export function PaletteHost({
	state,
	registry: live,
	call,
	window,
	onClose,
}: PaletteHostProps): ReactElement {
	const catalog = useMemo(() => {
		const shortcuts = shellDescriptions.flatMap((shortcut) => {
			if (live === undefined) return [shortcut];
			const registered = live.find(
				(row) => row.path.join(":") === [SHELL_PROGRAM_ID, ...shortcut.path].join(":"),
			);
			return registered === undefined ? [] : [{...registered, path: shortcut.path}];
		});
		const paths = new Set(shortcuts.map((row) => row.path.join(":")));
		const addresses = new Set(shortcuts.map((row) => [SHELL_PROGRAM_ID, ...row.path].join(":")));
		return {
			shortcuts: paths,
			descriptions: [
				...shortcuts,
				...(live ?? []).filter(
					(row) => !paths.has(row.path.join(":")) && !addresses.has(row.path.join(":")),
				),
			],
		};
	}, [live]);
	const descriptions = catalog.descriptions;
	const registry = useMemo(() => buildSpellIndex(descriptions), [descriptions]);
	const [reply, setReply] = useState<SpellReply | null>(null);
	const request = useRef(0);
	const running = useRef<Fiber.Fiber<unknown> | null>(null);
	const currentCall = useRef(call);
	currentCall.current = call;
	const invalidate = useCallback(() => {
		request.current += 1;
		if (running.current !== null) Effect.runFork(Fiber.interrupt(running.current));
		running.current = null;
	}, []);
	useEffect(() => {
		invalidate();
		setReply(null);
		return invalidate;
	}, [call, invalidate]);
	const snapshot = useMemo(() => commandSnapshot(state, descriptions), [state, descriptions]);

	const onCall = useCallback(
		(spell: SpellCall) => {
			if (call === undefined) {
				setReply(refusal(spell, "tuval/NoKernel", "this surface has no kernel to call"));
				return;
			}
			invalidate();
			const ticket = request.current;
			const accept = (answer: SpellReply) =>
				Effect.sync(() => {
					if (ticket === request.current && currentCall.current === call) setReply(answer);
				});
			running.current = Effect.runFork(
				call(catalog.shortcuts.has(spell.path.join(":")) ? onTheRegistry(spell) : spell).pipe(
					Effect.flatMap(accept),
					Effect.catch(() =>
						accept(refusal(spell, "tuval/SocketGone", "the desk lost its link to the kernel")),
					),
				),
			);
		},
		[call, catalog, invalidate],
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
