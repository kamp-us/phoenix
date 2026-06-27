/** pasaport's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule} from "../fate/module.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {
	accountDeletionReceiptSource,
	contributionSource,
	profileSource,
	promotionReceiptSource,
	userSource,
} from "./sources.ts";

export const fateModule = {
	queries,
	mutations,
	sources: [
		userSource,
		profileSource,
		contributionSource,
		accountDeletionReceiptSource,
		promotionReceiptSource,
	],
} satisfies FateModule;
