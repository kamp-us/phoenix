/**
 * The board the repo a verb stands in declares — the one read every verb takes its status labels
 * off, by role.
 *
 * A refused read never falls back to the shipped names: a repo that renamed a status carries no
 * issue under the old label, so a verb querying it would answer an empty result as a clean success.
 * Each verb words that refusal in its own voice and seats it on its own `11`; what is shared is the
 * read and the name the refusal gives it.
 *
 * Kept apart from `./label-remedy.ts`, which reads the bootstrap registry: a verb that only needs
 * the board has no business loading every bootstrap surface to get it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/6428#issuecomment-5363116003
 */

import {Effect, type FileSystem, type Path} from "effect";
import {CONFIG_PATH} from "../config/document.ts";
import {type BoardRead, resolveBoard} from "../config/resolve-board.ts";
import {loadRepoConfig} from "../config/working-root.ts";
import {FACET_VOCABULARY} from "../triage/facets.ts";

/** What a verb's "cannot read" refusal calls a board that did not resolve. */
export const BOARD_SUBJECT = `${CONFIG_PATH}'s board vocabulary`;

/** The board the repo above `cwd` declares, or the reason none of it may be used. */
export const readBoard = (
	cwd: string,
): Effect.Effect<BoardRead, never, FileSystem.FileSystem | Path.Path> =>
	Effect.map(loadRepoConfig(cwd), (load) => resolveBoard(load, FACET_VOCABULARY));

/** A refused board's reason, fit to sit mid-sentence: each key words its own, period or not. */
export const refusalReason = (read: Extract<BoardRead, {readonly _tag: "Refused"}>): string =>
	read.reason.replace(/\.$/, "");
