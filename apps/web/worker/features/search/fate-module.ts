/** search's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule} from "../fate/module.ts";
import {lists} from "./lists.ts";

export const fateModule = {lists} satisfies FateModule;
