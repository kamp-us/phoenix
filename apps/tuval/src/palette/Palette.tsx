/**
 * The palette: one desk-level overlay at the top centre of the whole app, over whatever the desk is
 * showing.
 *
 * **It is not anchored to the focused window.** The founder's 2026-09-04 correction on #7643 rules
 * that out — a window may resize or close under it — so the palette sits where neovim's, tmux's and
 * VS Code's do, at a fixed width in the same place every time. The focused window still supplies the
 * call's scope: scope comes from focus, not from where the palette sits, which is why `window` is a
 * prop the opener names rather than anything this component reads off the layout.
 *
 * **One text field, and the options are never focusable.** This is the ARIA combobox pattern: the
 * caret stays in the input for the palette's whole life and the active row is named by
 * `aria-activedescendant`, so Tab is free to mean "accept this completion" the way it does in a
 * shell. The input is therefore the only tabbable element inside the dialog, which is what makes the
 * focus trap total — Tab from it comes back to it.
 *
 * **Completion is local and synchronous.** `paletteCandidates` runs against the snapshot the page
 * already holds, on every keystroke, never awaiting the kernel (#7617 R1.5). The only thing that
 * crosses the wire is the `SpellCall` Enter sends — the one page-to-kernel message there is (ADR
 * 0348, `.patterns/tuval-spells.md`).
 *
 * Every element here is a `@kampus/design` primitive or a role token from its layer; nothing in
 * `./palette.css` names a colour (`design-system-manifest.md`, Pillar 2).
 */

import {Dialog, Input, Kbd} from "@kampus/design";
import type {KeyboardEvent, ReactElement} from "react";
import {useCallback, useEffect, useId, useMemo, useRef, useState} from "react";
import type {ParseResult} from "../commands/parse/parse.ts";
import {parse} from "../commands/parse/parse.ts";
import {describeExpected, type SpellIndex} from "../commands/parse/spell-index.ts";
import {renderPath} from "../commands/spell.ts";
import type {WindowId} from "../protocol/ids.ts";
import type {Snapshot, SpellCall, SpellReply} from "../protocol/messages.ts";
import {failureLine, type MintCallId, randomCallId, spellCallFor} from "./call.ts";
import {acceptCandidate, paletteCandidates} from "./candidates.ts";
import "./palette.css";

export interface PaletteProps {
	/** The desk as the kernel last sent it: where every live value a completion offers comes from. */
	readonly snapshot: Snapshot;
	readonly registry: SpellIndex;
	/** The window focused when the palette opened. It is the call's scope, never the layout's. */
	readonly window?: WindowId;
	/**
	 * The kernel's answer to the call this palette sent. A reply for any other call is ignored, so a
	 * page holding one socket for the whole desk can hand every reply to every palette.
	 */
	readonly reply?: SpellReply | null;
	readonly onCall: (call: SpellCall) => void;
	readonly onClose: () => void;
	readonly initialInput?: string;
	/** The correlation id mint. The platform's `crypto.randomUUID` unless a test pins it. */
	readonly mintCallId?: MintCallId;
}

/** The sentence for the spell the line names, whether or not the line is finished. */
const describeLine = (reading: ParseResult, registry: SpellIndex): string | undefined => {
	if (reading._tag === "Partial") return reading.spell?.describe;
	if (reading._tag !== "Complete") return undefined;
	const named = renderPath(reading.call.path);
	return registry.spells.find((spell) => renderPath(spell.path) === named)?.describe;
};

export function Palette({
	snapshot,
	registry,
	window,
	reply = null,
	onCall,
	onClose,
	initialInput = "",
	mintCallId = randomCallId,
}: PaletteProps): ReactElement {
	const baseId = useId();
	const input = useRef<HTMLInputElement>(null);
	const [line, setLine] = useState(initialInput);
	const [active, setActive] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);

	const candidates = useMemo(
		() => paletteCandidates(line, registry, snapshot),
		[line, registry, snapshot],
	);
	const reading = useMemo(() => parse(line, registry, snapshot), [line, registry, snapshot]);
	const index = candidates.length === 0 ? -1 : Math.min(active, candidates.length - 1);
	const focused = index < 0 ? undefined : candidates[index];

	// The prompt opens because a key asked for it, so the caret belongs here the moment it exists.
	// `usePalette` hands it back to the opener on close.
	useEffect(() => {
		input.current?.focus();
	}, []);

	// The reply is a prop rather than `onCall`'s return, because replies arrive on the page's one
	// socket rather than per call. Matching on the id is what lets the caller forward all of them.
	//
	// Each reply is consumed once, keyed on the value the caller passed rather than on its id: the id
	// is the caller's to mint, and a second call that reuses one would otherwise be answered by the
	// reply the first call already spent.
	const consumed = useRef<SpellReply | null>(null);
	useEffect(() => {
		if (reply === null || reply === undefined || consumed.current === reply) return;
		consumed.current = reply;
		if (pending === null || reply.id !== pending) return;
		setPending(null);
		if (reply.ok) {
			onClose();
			return;
		}
		setError(failureLine(reply.error));
	}, [reply, pending, onClose]);

	const retype = useCallback((next: string) => {
		setLine(next);
		setActive(0);
		setError(null);
	}, []);

	const step = useCallback(
		(delta: 1 | -1) =>
			setActive((current) =>
				candidates.length === 0
					? 0
					: (Math.min(current, candidates.length - 1) + delta + candidates.length) %
						candidates.length,
			),
		[candidates.length],
	);

	const run = useCallback(() => {
		if (reading._tag !== "Complete") return false;
		const call = spellCallFor(reading.call, window, mintCallId);
		setPending(call.id);
		setError(null);
		onCall(call);
		return true;
	}, [reading, window, mintCallId, onCall]);

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		switch (event.key) {
			case "Escape":
				event.preventDefault();
				onClose();
				return;
			case "ArrowDown":
				event.preventDefault();
				step(1);
				return;
			case "ArrowUp":
				event.preventDefault();
				step(-1);
				return;
			case "Home":
				event.preventDefault();
				setActive(0);
				return;
			case "End":
				event.preventDefault();
				setActive(Math.max(0, candidates.length - 1));
				return;
			case "Tab":
				// Always swallowed, whether or not there is a row to accept: the input is the only
				// tabbable element in the dialog, so this is also what closes the focus trap.
				event.preventDefault();
				if (focused !== undefined) retype(acceptCandidate(line, focused));
				return;
			case "Enter":
				event.preventDefault();
				// A line the parser can already run is run. Only an unfinished one spends Enter on the
				// completion, so `workspace new scratch` calls the spell even while `scratch` is still
				// offered as a value below it.
				if (!run() && focused !== undefined) retype(acceptCandidate(line, focused));
				return;
			default:
		}
	};

	const listId = `${baseId}-list`;
	const activeId = index < 0 ? undefined : `${baseId}-option-${index}`;
	const expected = reading._tag === "Partial" ? reading.cursorArg : undefined;
	// The focused row's own sentence when it has one; otherwise the spell the line already names,
	// which is what a caret sitting on an argument is still describing. The band is never blank while
	// the line names something: an empty strip under a full list is the void Pillar 3 forbids.
	const detail = focused?.describe ?? describeLine(reading, registry);

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
			title="Command palette"
			showCloseButton={false}
			closeOnEscape={false}
			size="lg"
			className="tuval-palette"
		>
			<div className="tuval-palette__body">
				<Input
					ref={input}
					type="text"
					role="combobox"
					aria-label="Run a spell"
					aria-autocomplete="list"
					aria-expanded
					aria-controls={listId}
					aria-activedescendant={activeId}
					// `error` rather than a hand-rolled message: the field primitive owns the invalid
					// state, the `aria-describedby` wiring and the polite live region the refusal is
					// announced through, and a11y is the shared primitive's property rather than this
					// component's paint (`design-system-manifest.md`, Pillar 4).
					error={error ?? undefined}
					autoComplete="off"
					spellCheck={false}
					placeholder="window close"
					value={line}
					fullWidth
					className="tuval-palette__input"
					onChange={(event) => retype(event.currentTarget.value)}
					onKeyDown={onKeyDown}
				/>

				{/* The field's own message is what a reader sees. This is what a screen reader hears: the
				    caret is already in the field when a call is refused, so the `aria-describedby` the
				    field wires up is never re-announced and only a live region carries the refusal. */}
				<div className="tuval-palette__announce" aria-live="polite">
					{error ?? ""}
				</div>

				{/* `div`s rather than a `ul`/`li` pair, the shape `@kampus/design`'s own `CommandPalette`
				    uses: a list element carrying an interactive role is two contradicting semantics, and
				    `tabIndex={-1}` is what keeps a row addressable by `aria-activedescendant` without
				    putting it in the tab order the input owns. */}
				<div className="tuval-palette__list" id={listId} role="listbox" aria-label="Spells">
					{candidates.map((candidate, position) => (
						<div
							key={`${candidate.kind}:${candidate.label}`}
							id={`${baseId}-option-${position}`}
							className="tuval-palette__option"
							role="option"
							tabIndex={-1}
							aria-selected={position === index}
							data-active={position === index ? "" : undefined}
							onPointerMove={() => setActive(position)}
							onPointerDown={(event) => {
								event.preventDefault();
								retype(acceptCandidate(line, candidate));
							}}
						>
							<span className="tuval-palette__label">{candidate.label}</span>
							{candidate.describe === undefined ? null : (
								<span className="tuval-palette__describe">{candidate.describe}</span>
							)}
						</div>
					))}
				</div>

				<p className="tuval-palette__detail">
					{candidates.length === 0 && reading._tag !== "Complete"
						? "No spell matches what you have typed."
						: detail}
					{expected === undefined ? null : (
						<span className="tuval-palette__expected"> {describeExpected(expected)}</span>
					)}
				</p>

				<p className="tuval-palette__legend">
					<Kbd>Tab</Kbd> complete · <Kbd>Enter</Kbd> run · <Kbd>Esc</Kbd> close
				</p>
			</div>
		</Dialog>
	);
}
