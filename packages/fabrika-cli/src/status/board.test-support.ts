import {loadConfig} from "../config/load.ts";
import {type BoardRead, resolveBoard} from "../config/resolve-board.ts";
import {FACET_VOCABULARY} from "../triage/facets.ts";

/** The board a repo that declared nothing resolves to. */
export const SHIPPED_BOARD: BoardRead = resolveBoard(
	loadConfig({_tag: "Absent"}),
	FACET_VOCABULARY,
);

/** The board a repo whose `.fabrika.jsonc` declares `config` resolves to. */
export const declaredBoard = (config: Record<string, unknown>): BoardRead =>
	resolveBoard(loadConfig({_tag: "Text", text: JSON.stringify(config)}), FACET_VOCABULARY);
