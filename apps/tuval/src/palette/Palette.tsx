/**
 * The palette: one desk-level overlay at the top centre of the whole app, over whatever the desk is
 * showing.
 *
 * **The combobox is `@kampus/design`'s `CommandPalette`, not a local one.** The dialog, the field,
 * the listbox, the option rows, `aria-activedescendant` and the scroll-into-view all belong to the
 * shared component (ADR 0186, `.patterns/command-palette.md`); what lives here is Tuval's own half —
 * the candidates, the completion, the call, and the three hooks the shared component grew for them
 * (#7882). A second implementation of this a11y pattern is what that ticket deleted.
 *
 * **It is not anchored to the focused window.** The founder's 2026-09-04 correction on #7643 rules
 * that out — a window may resize or close under it — so the palette sits where neovim's, tmux's and
 * VS Code's do, at a fixed width in the same place every time, carried through the shared
 * component's `className`. The focused window still supplies the call's scope: scope comes from
 * focus, not from where the palette sits, which is why `window` is a prop the opener names rather
 * than anything this component reads off the layout.
 *
 * **Tab means "accept this completion", so this component claims it.** The shared component's
 * `onKeyDown` hook hands the key over before its own movement runs, and the preventDefault that
 * claims it is also what closes the focus trap: the field is the only tabbable element in the
 * dialog, so Tab from it comes back to it.
 *
 * **Completion is local and synchronous.** `paletteCandidates` runs against the snapshot the page
 * already holds, on every keystroke, never awaiting the kernel (#7617 R1.5). The only thing that
 * crosses the wire is the `SpellCall` Enter sends — the one page-to-kernel message there is (ADR
 * 0348, `.patterns/tuval-spells.md`).
 */

import type {CommandPaletteItem} from "@kampus/design";
import {CommandPalette, Kbd} from "@kampus/design";
import type {KeyboardEvent, ReactElement} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {ParseResult} from "../commands/parse/parse.ts";
import {parse} from "../commands/parse/parse.ts";
import {describeExpected, type SpellIndex} from "../commands/parse/spell-index.ts";
import {renderPath} from "../commands/spell.ts";
import type {WindowId} from "../protocol/ids.ts";
import type {Snapshot, SpellCall, SpellReply} from "../protocol/messages.ts";
import {failureLine, type MintCallId, randomCallId, spellCallFor} from "./call.ts";
import {acceptCandidate, type PaletteCandidate, paletteCandidates} from "./candidates.ts";
import "./palette.css";

export interface PaletteProps {
	/** The desk as the kernel last sent it: where every live value a completion offers comes from. */
	readonly snapshot: Snapshot;
	readonly registry: SpellIndex;
	/** The window focused when the palette opened. It is the call's scope, never the layout's. */
	readonly window?: WindowId | undefined;
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

/** One string, two readers: the sentence under an empty list and the sentence the region speaks. */
const NO_MATCH = "No spell matches what you have typed.";

/** What the polite region says as the line changes — how many spells match, or why none do. */
const resultLine = (count: number, runnable: boolean): string => {
	if (count === 0) return runnable ? "No completions left; the line is ready to run." : NO_MATCH;
	return count === 1 ? "1 spell matches." : `${count} spells match.`;
};

/** The sentence for the spell the line names, whether or not the line is finished. */
const describeLine = (reading: ParseResult, registry: SpellIndex): string | undefined => {
	if (reading._tag === "Partial") return reading.spell?.describe;
	if (reading._tag !== "Complete") return undefined;
	const named = renderPath(reading.call.path);
	return registry.spells.find((spell) => renderPath(spell.path) === named)?.describe;
};

/** The row's identity in the shared component's item list, and this module's way back to a candidate. */
const rowValue = (candidate: PaletteCandidate): string => `${candidate.kind}:${candidate.label}`;

/** `paletteCandidates` has already ranked and narrowed the rows, so the shared filter has no work. */
const alreadyFiltered = () => true;

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
	const [line, setLine] = useState(initialInput);
	const [active, setActive] = useState<CommandPaletteItem | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);

	const candidates = useMemo(
		() => paletteCandidates(line, registry, snapshot),
		[line, registry, snapshot],
	);
	const reading = useMemo(() => parse(line, registry, snapshot), [line, registry, snapshot]);

	const rows = useMemo(
		() => new Map(candidates.map((candidate) => [rowValue(candidate), candidate])),
		[candidates],
	);
	const items = useMemo<ReadonlyArray<CommandPaletteItem>>(
		() =>
			candidates.map((candidate) => ({
				value: rowValue(candidate),
				label: candidate.label,
				description: candidate.describe,
			})),
		[candidates],
	);
	const focused = active === undefined ? undefined : rows.get(active.value);

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
		setError(null);
	}, []);

	const accept = useCallback(
		(item: CommandPaletteItem | undefined): void => {
			const candidate = item === undefined ? undefined : rows.get(item.value);
			if (candidate !== undefined) retype(acceptCandidate(line, candidate));
		},
		[rows, line, retype],
	);

	const run = useCallback(() => {
		if (reading._tag !== "Complete") return false;
		const call = spellCallFor(reading.call, window, mintCallId);
		setPending(call.id);
		setError(null);
		onCall(call);
		return true;
	}, [reading, window, mintCallId, onCall]);

	const claimKey = useCallback(
		(event: KeyboardEvent<HTMLInputElement>, row: CommandPaletteItem | undefined): void => {
			if (event.key === "Escape") {
				// Closing is `usePalette`'s, because only it knows where the caret came from, so the
				// dialog's own Escape is off (`closeOnEscape={false}`) and this is the one route out.
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== "Tab") return;
			// Claimed whether or not there is a row to accept: this preventDefault is also what keeps
			// the caret in the field, and so what makes the dialog's focus trap total.
			event.preventDefault();
			accept(row);
		},
		[accept, onClose],
	);

	const expected = reading._tag === "Partial" ? reading.cursorArg : undefined;
	// The focused row's own sentence when it has one; otherwise the spell the line already names,
	// which is what a caret sitting on an argument is still describing. The band is dropped rather
	// than left blank when neither exists: an empty strip under a full list is the void Pillar 3
	// forbids, and an empty list carries the shared component's own no-match sentence instead.
	const detail = focused?.describe ?? describeLine(reading, registry);

	return (
		<CommandPalette
			items={items}
			open
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
			title="Run a spell"
			placeholder="window close"
			emptyLabel={NO_MATCH}
			closeOnEscape={false}
			query={line}
			onQueryChange={retype}
			filter={alreadyFiltered}
			closeOnSelect={false}
			shortcut={false}
			showSearchIcon={false}
			onSelect={accept}
			onKeyDown={claimKey}
			// A line the parser can already run is run. Only an unfinished one falls through to the
			// shared default, so `workspace new scratch` calls the spell even while `scratch` is still
			// offered as a value below it.
			onEnter={run}
			onActiveChange={setActive}
			announcement={error ?? resultLine(candidates.length, reading._tag === "Complete")}
			error={error ?? undefined}
			className="tuval-palette"
			footer={
				<>
					{detail === undefined && expected === undefined ? null : (
						<p className="tuval-palette__detail">
							{detail}
							{expected === undefined ? null : (
								<span className="tuval-palette__expected"> {describeExpected(expected)}</span>
							)}
						</p>
					)}
					<p className="tuval-palette__legend">
						<Kbd>Tab</Kbd> complete · <Kbd>Enter</Kbd> run · <Kbd>Esc</Kbd> close
					</p>
				</>
			}
		/>
	);
}
