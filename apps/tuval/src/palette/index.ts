/**
 * The palette slice: the desk-level command overlay, its state hook and the two pure translations
 * under them.
 *
 * The whole slice is browser-only, so it carries one barrel rather than the `index.ts` /
 * `browser.ts` pair a shared slice needs (`.patterns/tuval-shell-assembly.md`, "Two entry points,
 * two import surfaces"). Nothing here may import `node:*`: the page entry reaches every module in
 * this directory, and `tsconfig.browser.json` is what says so.
 */

export {failureLine, type MintCallId, randomCallId, spellCallFor} from "./call.ts";
export {
	acceptCandidate,
	type PaletteCandidate,
	type PaletteCandidateKind,
	paletteCandidates,
} from "./candidates.ts";
export {Palette, type PaletteProps} from "./Palette.tsx";
export {type PaletteHandle, usePalette} from "./use-palette.ts";
