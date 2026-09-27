/**
 * `./reloadable.ts` booted as a whole desk, so a reload can be asked for the way a person asks for
 * one: the `config.reload` Msg delivered to the shell the desk supplies (#9667, #9683). The generation
 * is read here, at import, from the same JSON file, rather than through `./reloadable.ts`'s default
 * export, so a second load of this module reads the file again whichever loader cached that one.
 */

import {readFileSync} from "node:fs";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/config";
import {type DeclaredConfig, declaredProgram} from "./reloadable.ts";

const declared = JSON.parse(
	readFileSync(process.env.TUVAL_RELOAD_FIXTURE ?? "", "utf8"),
) as DeclaredConfig;

export default {
	version: 1,
	programs: declared.programs.map(declaredProgram),
	keys: declared.keys,
} satisfies TuvalConfigInput;
