/** sözlük's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {definitionSource, termSource} from "./sources.ts";

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [definitionSource, termSource],
} satisfies FateModule;
