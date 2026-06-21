/** stats' contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule} from "../fate/module.ts";
import {queries} from "./queries.ts";

export const fateModule = {queries} satisfies FateModule;
