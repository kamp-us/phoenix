/**
 * The boot-mode observer for the edge-resolved shell (ADR 0179, epic #2926).
 *
 * The worker-first render has no user-facing surface of its OWN — the visible shell geometry
 * rides the `__BOOT__` members (nav flags + `user`) that `App.tsx` already reads. This module
 * reports whether the edge actually injected the payload for this render, exposed as a
 * geometry-inert marker so the first-paint e2e (and future diagnostics) can observe the mode.
 */
import type {ReactElement} from "react";
import {readBoot} from "./boot.ts";

/**
 * Whether the edge injected `window.__BOOT__` for this render. Absent ⇒ the never-hang fallback
 * (ADR 0179 §4) served an untransformed asset, so the client resolves through its fetch path —
 * a first-class state, not an error.
 */
export function useEdgeShellBootActive(): boolean {
	return readBoot() !== undefined;
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
