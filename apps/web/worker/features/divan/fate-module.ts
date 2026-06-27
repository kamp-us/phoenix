/** divan's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {divanBacklogItemSource, divanCaylakSource} from "./sources.ts";

export const fateModule = {
	lists,
	sources: [divanCaylakSource, divanBacklogItemSource],
} satisfies FateModule;
