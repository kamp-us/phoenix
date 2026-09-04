import {account} from "./account";
import {auth} from "./auth";
import {layout} from "./layout";
import {mecmua} from "./mecmua";
import {pano} from "./pano";
import {sozluk} from "./sozluk";
import {wire} from "./wire";

/**
 * The Turkish catalog — every surface file merged into one flat record. This is the key set
 * `CatalogKey` is derived from, so adding a key here is what makes it exist at all; `en` is
 * then checked against it (ADR 0347).
 */
export const tr = {
	...account,
	...auth,
	...layout,
	...mecmua,
	...pano,
	...sozluk,
	...wire,
};
