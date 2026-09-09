/**
 * The process board: one tile per process, children nested in their parent's tile (#8723).
 *
 * Built on the base contract only (#8715 R8.1). A tile is what the kernel row gives — program id,
 * state, port count — plus the two generic ports any program may declare, `title@1` and `status@1`.
 * Nothing here names a harness, a model or an agent: a demo counter and a Claude session are drawn
 * by the same path, and "what kind of thing is this" is whatever the program's own status line
 * says. A program declaring neither port still gets a tile.
 *
 * Every tile is a button, so the keyboard reaches what the mouse does through the one handler the
 * mouse calls. The board is not the engine view (#7500), which stays out of this slice.
 */

import {Card, EmptyState, MetaRow} from "@kampus/design";
import type {ReactElement, KeyboardEvent as ReactKeyboardEvent} from "react";
import {useEffect, useMemo, useRef, useState} from "react";
import type {ProcessId} from "../../process/process.ts";
import type {TableRow} from "../../table/row.ts";
import {enteredSince, type Tile, tileIds, tilesOf} from "./tiles.ts";
import "./board.css";

/** What a process says about itself before it has said anything: its program id, and that alone. */
const tileHeading = (tile: Tile): string => tile.title ?? tile.programId;

const portsLabel = (ports: number): string => (ports === 1 ? "1 port" : `${ports} ports`);

function TileRow({
	tile,
	entering,
	onOpen,
}: {
	readonly tile: Tile;
	readonly entering: ReadonlySet<ProcessId>;
	readonly onOpen: (processId: ProcessId) => void;
}): ReactElement {
	return (
		<li className="tuval-board-item">
			{/* The tile is one box holding its own line and its children's tiles, so "nested inside its
			    parent" is what the DOM says and not only what the indent suggests. */}
			<Card
				className="tuval-board-tile"
				data-process={tile.processId}
				{...(entering.has(tile.processId) ? {"data-entering": "true"} : {})}
			>
				{/*
				 * Enter and Space activate this button natively, which is why no key handler does the
				 * opening — a second copy of the activation is exactly what drifts. The one thing the
				 * handler below does is keep the press off the desk: the desk's single document-level
				 * listener (`../ui/Desk.tsx`) would otherwise forward this Enter to the focused window
				 * too, so opening a tile would also type into whatever chat is behind it.
				 */}
				<button
					type="button"
					className="tuval-board-open"
					onClick={() => onOpen(tile.processId)}
					onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
						if (event.key === "Enter" || event.key === " ") event.stopPropagation();
					}}
				>
					<span className="tuval-board-tile-heading">{tileHeading(tile)}</span>
					<MetaRow as="span" className="tuval-board-tile-meta">
						{/* The program id is the heading when the process publishes no title, and printing it
						    twice would spend the tile's one strong line on a repeat. */}
						{tile.title === null ? null : (
							<>
								<span data-field="program">{tile.programId}</span>
								<MetaRow.Dot />
							</>
						)}
						{/* The state is the word itself, never a colour: Pillar 4 forbids meaning on colour alone. */}
						<span data-field="state">{tile.lifecycle}</span>
						<MetaRow.Dot />
						<span data-field="ports">{portsLabel(tile.ports)}</span>
					</MetaRow>
					{tile.status === null ? null : (
						<span className="tuval-board-tile-status" data-field="status">
							{tile.status}
						</span>
					)}
				</button>
				{tile.children.length === 0 ? null : (
					<ul className="tuval-board-children">
						{tile.children.map((child) => (
							<TileRow key={child.processId} tile={child} entering={entering} onOpen={onOpen} />
						))}
					</ul>
				)}
			</Card>
		</li>
	);
}

export interface ProcessBoardProps {
	/** The process table as the page holds it; the tile model is what turns it into a forest. */
	readonly rows: Iterable<TableRow>;
	/** Open a process in a window — the desk's own `window.attach` (`../../page/AttachedDesk.tsx`). */
	readonly onOpen: (processId: ProcessId) => void;
	/**
	 * The operator asked for no motion. Then no tile is marked as entering at all, rather than
	 * animating a zero-length animation: what the mark drives is the one animation on this surface.
	 */
	readonly reducedMotion: boolean;
}

export function ProcessBoard({rows, onOpen, reducedMotion}: ProcessBoardProps): ReactElement {
	const tiles = useMemo(() => tilesOf(rows), [rows]);
	const ids = useMemo(() => tileIds(tiles), [tiles]);
	/** The board drawn before this one; `null` until the first has been drawn (`./tiles.ts`). */
	const drawn = useRef<ReadonlySet<ProcessId> | null>(null);
	const [entering, setEntering] = useState<ReadonlySet<ProcessId>>(new Set());

	useEffect(() => {
		const fresh = reducedMotion ? new Set<ProcessId>() : enteredSince(drawn.current, ids);
		drawn.current = ids;
		// Two empties are the same answer, and swapping one for the other would re-render the board on
		// every unrelated row update — a status line ticks far more often than a process spawns.
		setEntering((held) => (fresh.size === 0 && held.size === 0 ? held : fresh));
	}, [ids, reducedMotion]);

	return (
		<section className="tuval-board" aria-label="Processes">
			<h2 className="tuval-board-heading">Processes</h2>
			{tiles.length === 0 ? (
				<EmptyState
					className="tuval-board-empty"
					title="Nothing is running"
					description="Every process the kernel holds shows up here as a tile. Open one from the picker to start."
				/>
			) : (
				<ul className="tuval-board-tiles">
					{tiles.map((tile) => (
						<TileRow key={tile.processId} tile={tile} entering={entering} onOpen={onOpen} />
					))}
				</ul>
			)}
		</section>
	);
}
