/**
 * The fake agy's conversation counters, handed from one child to the next through a file.
 *
 * A respawn kills the old child with a signal and starts the new one at once, so the old child can
 * die at any instruction and the new one reads whatever is on disk. Two rules keep that read true:
 *
 * - **A save replaces the file by rename.** `writeFileSync` truncates before it writes, so a reader
 *   (or a kill) landing between the two sees an empty or partial file. A rename swaps the whole
 *   file in one step, so a reader sees the previous state or the next one and nothing between.
 * - **Only an absent file is a first launch.** Any other failure to read or parse is an error, never
 *   zeroed counters: a restarted count would alias the usage keys the ledger already holds, which
 *   is the defect #8695 was about and the flake #9584 was.
 */

import {readFileSync, renameSync, writeFileSync} from "node:fs";

export const firstLaunch = Object.freeze({steps: 0, turns: 0, input: 0, output: 0});

export const readConversationState = (path) => {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return firstLaunch;
		throw error;
	}
	try {
		return JSON.parse(raw);
	} catch (cause) {
		throw new Error(`the conversation state at ${path} is unreadable: ${JSON.stringify(raw)}`, {
			cause,
		});
	}
};

export const saveConversationState = (path, state) => {
	const staged = `${path}.${process.pid}.tmp`;
	writeFileSync(staged, JSON.stringify(state));
	renameSync(staged, path);
};
