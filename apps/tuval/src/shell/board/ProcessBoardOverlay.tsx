/**
 * The process board as tmux pulls its tree picker up: hidden by default, over the desk while it is
 * open, gone again on the same chord or on Escape (#8867). The band this replaced cost the windows
 * about a third of the page height on every desk, open or not.
 *
 * **The dialog is `@kampus/design`'s, not a local overlay.** The focus trap, the return of focus to
 * whatever held it, Escape, the backdrop and the `aria-modal` announcement are all the shared
 * component's — `packages/design/src/Dialog.tsx` over Manti's zag dialog machine — which is the same
 * reason the palette does not roll its own (ADR 0186). The title is the dialog's, so `ProcessBoard`
 * draws no heading of its own: two "Processes" headings is what a second implementation looks like.
 *
 * **Visibility is not held here.** `open` comes off the shell snapshot and every dismissal goes back
 * as a Msg, because the board is one desk-level surface and the page holds no desk state (#7556).
 */

import {Dialog} from "@kampus/design";
import type {ReactElement} from "react";
import type {ProcessId} from "../../process/process.ts";
import type {TableRow} from "../../table/row.ts";
import {ProcessBoard} from "./ProcessBoard.tsx";

export interface ProcessBoardOverlayProps {
	readonly open: boolean;
	/** The board is gone: Escape, a click outside, the chord again, or a tile that opened a window. */
	readonly onClose: () => void;
	readonly rows: Iterable<TableRow>;
	readonly onOpen: (processId: ProcessId) => void;
	readonly reducedMotion: boolean;
}

export function ProcessBoardOverlay({
	open,
	onClose,
	rows,
	onOpen,
	reducedMotion,
}: ProcessBoardOverlayProps): ReactElement {
	return (
		<Dialog
			title="Processes"
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
			// The desk's own chrome carries no close button either; the chord and Escape are the door.
			showCloseButton={false}
			size="lg"
			className="tuval-board-overlay"
		>
			<ProcessBoard
				rows={rows}
				onOpen={(processId) => {
					onOpen(processId);
					onClose();
				}}
				reducedMotion={reducedMotion}
			/>
		</Dialog>
	);
}
