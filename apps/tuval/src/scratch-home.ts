/**
 * The throwaway home dir a test or a proof boots under.
 *
 * `BootOptions.home` is required rather than defaulted because saved state lives under the home
 * dir, keyed by the project's absolute path (ADR 0402, `./state-dir.ts`): a boot that named no home
 * would write that desk's manifest, its process checkpoints and its Pi session files into the
 * operator's own `~/.tuval`, so a suite run would leave a desk's state on the machine it ran on.
 * `src/bin.ts` is the one caller that means the real home dir; everything else names one of these.
 */

import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const made: Array<string> = [];

/**
 * A fresh, empty home dir, removed when this process exits — so a caller owes it no cleanup and
 * two files never share one. `realpath` because macOS resolves `/var` to `/private/var` and a boot
 * reports the paths it was given.
 */
export const scratchHome = (label: string): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `tuval-home-${label}-`)));
	made.push(dir);
	return dir;
};

process.on("exit", () => {
	for (const dir of made.splice(0)) rmSync(dir, {recursive: true, force: true});
});
