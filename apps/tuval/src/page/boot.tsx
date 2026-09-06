/**
 * What the page's entry mounts: the connection lifecycle (`./connection.ts`) and the desk over
 * whichever link it currently holds.
 *
 * The root is mounted **before** anything is attached. Mounting on success alone left every failure
 * — a refused handshake most of all — showing a blank page with the reason only on the terminal,
 * which is how a transport that refused the page's own origin went unnoticed (#7560).
 *
 * `AttachedDesk` is rendered at one position and handed new props when the link is replaced, never
 * remounted under a fresh `key`: its desk, its key grammar and its window subscriptions are what a
 * founder keeps looking at across the gap, and a remount would throw all three away and blank the
 * tab — the thing automatic recovery exists to avoid (#8004).
 *
 * Taking `Recovery` as an argument is what lets the browser proof run this same page with recovery
 * off, so its fresh-output assertion is falsifiable rather than merely green
 * (`./proof/no-recovery.tsx`).
 */

import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {ErrorBoundary} from "../shell/ui/index.ts";
import {AttachedDesk} from "./AttachedDesk.tsx";
import {defaultRecovery, type Recovery, usePageConnection} from "./connection.ts";
import {pageRenderers} from "./renderers.tsx";

/** Shown while the first socket is opening, and replaced by the desk or by the reason it never opened. */
const Attaching = () => (
	<div className="tuval-surface">
		<p className="tuval-placeholder" role="status">
			Attaching to the Tuval kernel…
		</p>
	</div>
);

/** The reason, on the page. A founder reading a blank tab has nowhere to learn what refused them. */
const AttachFailed = ({reason}: {readonly reason: string}) => (
	<div className="tuval-surface">
		<div className="tuval-placeholder tuval-attach-failed" role="alert">
			<p>Tuval could not attach to the kernel.</p>
			<p className="tuval-attach-reason">{reason}</p>
		</div>
	</div>
);

const PageDesk = ({recovery}: {readonly recovery: Recovery}) => {
	const connection = usePageConnection(recovery);
	const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;

	if (connection.link === null) {
		return connection.refusal === null ? (
			<Attaching />
		) : (
			<AttachFailed reason={connection.refusal} />
		);
	}
	return (
		<AttachedDesk
			page={connection.link.page}
			shell={connection.link.shell}
			refusal={connection.refusal}
			renderers={pageRenderers}
			reducedMotion={reducedMotion}
		/>
	);
};

export interface BootOptions {
	readonly recovery?: Recovery;
}

/** Mount the page into `#tuval`. Throws if the document has no host element; there is no page then. */
export const bootPage = (options?: BootOptions): void => {
	const host = document.getElementById("tuval");
	if (host === null) throw new Error("tuval: the page has no #tuval element");
	createRoot(host).render(
		<StrictMode>
			{/* The outer net. `Desk` catches a throw from the tiling area and keeps its own chrome, so
			    this one is for everything above that — the attach panels, the status line, the command
			    line — where the alternative is the blank tab of #7839 and #7560 again. */}
			<ErrorBoundary label="Tuval" className="tuval-surface">
				<PageDesk recovery={options?.recovery ?? defaultRecovery} />
			</ErrorBoundary>
		</StrictMode>,
	);
};
