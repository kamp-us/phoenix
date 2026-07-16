/**
 * The consuming-UI tie-in for the edge-resolved shell-boot vertical (ADR 0173 §1a, epic #2926).
 *
 * `PHOENIX_EDGE_SHELL_BOOT` is the single containment seam for the whole worker-first shell
 * render (ADR 0179): it has no user-facing surface of its OWN — the visible shell geometry rides
 * the per-flag `__BOOT__` members (nav flags + `user`) that `App.tsx` already reads. This module
 * is the one `.tsx` that references the containment constant, reporting whether the edge-resolved
 * boot path is active for this client and exposing it as a geometry-inert marker so the
 * `@journey:phoenix-edge-shell-boot` e2e (and future diagnostics) can observe the boot mode.
 */
import type {ReactElement} from "react";
import {readBoot} from "./boot.ts";
import {PHOENIX_EDGE_SHELL_BOOT} from "./keys.ts";
import {useFlag} from "./useFlag.ts";

/**
 * Whether the edge-resolved shell-boot path is active for this render: the worker already
 * injected `window.__BOOT__` (the shell rendered through the worker), OR the containment flag
 * resolved on via the fetch path (the never-hang fallback served an untransformed asset with the
 * flag still on). Absent both ⇒ today's edge-direct, client-fetched shell.
 */
export function useEdgeShellBootActive(): boolean {
	const {value: flagOn} = useFlag(PHOENIX_EDGE_SHELL_BOOT, false);
	return flagOn || readBoot() !== undefined;
}

/**
 * A geometry-inert marker exposing the boot mode. `hidden` keeps it out of layout entirely, so it
 * can never contribute the layout shift the vertical exists to eliminate — mounting it in the
 * shell is free of first-paint cost.
 */
export function EdgeShellBootMarker(): ReactElement {
	const active = useEdgeShellBootActive();
	return <div hidden data-testid="edge-shell-boot" data-active={active ? "true" : "false"} />;
}
