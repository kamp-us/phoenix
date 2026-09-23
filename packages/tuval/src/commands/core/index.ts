import type {AnySpell} from "../spell.ts";
import {helpSpell} from "./help.ts";
import {spellDescribe, spellList} from "./spell.ts";

export {
	HelpRow,
	HelpRows,
	helpRows,
	helpSpell,
	renderHelp,
	segmentsOf,
} from "./help.ts";
export {spellDescribe, spellList} from "./spell.ts";

/** The three discovery spells. The proof child composes this list into boot; nothing here does. */
export const helpSpells: ReadonlyArray<AnySpell> = [helpSpell, spellList, spellDescribe];
