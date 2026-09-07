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

import moduleLoaders from "virtual:tuval/module-renderers";
import {Effect} from "effect";
import {StrictMode, useEffect, useMemo, useState} from "react";
import {createRoot} from "react-dom/client";
import {ErrorBoundary} from "../shell/ui/index.ts";
import type {RendererTable} from "../shell/window/index.ts";
import {AttachedDesk} from "./AttachedDesk.tsx";
import {defaultRecovery, type Recovery, usePageConnection} from "./connection.ts";
import {type LoadedModuleRenderers, loadModuleRenderers} from "./module-renderers.ts";
import {pageInspectors, pageRenderers} from "./renderers.tsx";

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

/**
 * Every module the rows asked the page to load, once loaded; `null` until then. The desk waits for
 * it exactly as it waits for the socket, so a module-referenced window is never resolved against a
 * table its entry has not reached yet — that would render the placeholder for one frame and the
 * window the next, which reads as a flicker and lies about the row. A module that did not load is
 * in the table too, as the failure the resolver reports (ADR 0359).
 */
const useLoadedModules = (): LoadedModuleRenderers | null => {
	const [loaded, setLoaded] = useState<LoadedModuleRenderers | null>(null);
	useEffect(() => {
		let current = true;
		Effect.runPromise(loadModuleRenderers(moduleLoaders)).then((table) => {
			if (current) setLoaded(table);
		});
		return () => {
			current = false;
		};
	}, []);
	return loaded;
};

const PageDesk = ({recovery}: {readonly recovery: Recovery}) => {
	const connection = usePageConnection(recovery);
	const loaded = useLoadedModules();
	const link = connection.link;
	const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;

	// Rebuilt when the link is replaced, because the compiled half is bound to that socket's `call`
	// (`./renderers.tsx`): a table held across a re-attach would send this desk's next read down a
	// socket the page has already thrown away.
	const renderers = useMemo<RendererTable | null>(
		() => (link === null || loaded === null ? null : {...pageRenderers(link.page.call), ...loaded}),
		[link, loaded],
	);

	if (link === null || renderers === null) {
		return connection.refusal === null ? (
			<Attaching />
		) : (
			<AttachFailed reason={connection.refusal} />
		);
	}
	return (
		<AttachedDesk
			page={link.page}
			shell={link.shell}
			refusal={connection.refusal}
			renderers={renderers}
			inspectors={pageInspectors}
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
