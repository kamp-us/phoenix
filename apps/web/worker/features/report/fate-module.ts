/** report's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {openReportSource, reportReceiptSource, resolveReceiptSource} from "./sources.ts";

export const fateModule = {
	lists,
	mutations,
	sources: [reportReceiptSource, openReportSource, resolveReceiptSource],
} satisfies FateModule;
