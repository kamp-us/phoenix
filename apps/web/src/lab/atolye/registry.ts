/**
 * The exhibit registry — the headless seam of atölye. A plain typed array the index route
 * (#3092), the detail route (#3093), and a test/agent all import to enumerate or resolve an
 * exhibit without rendering. Adding an exhibit is one colocated `*.exhibit.tsx` module plus
 * one line here; the array order IS the curation order. No route ever edits to gain a piece.
 */

import type {AnyExhibit} from "./exhibit";
import {buttonExhibit} from "./exhibits/Button.exhibit";

const exhibits: readonly AnyExhibit[] = [buttonExhibit];

/** Every registered exhibit, in curated order — headless, renders nothing. */
export function listExhibits(): readonly AnyExhibit[] {
	return exhibits;
}

/** Resolve one exhibit by its slug; `undefined` for an unknown id (the detail route's not-found). */
export function getExhibit(id: string): AnyExhibit | undefined {
	return exhibits.find((exhibit) => exhibit.id === id);
}
