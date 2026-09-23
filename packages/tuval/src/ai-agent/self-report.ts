/**
 * What an AI-agent process says about itself on the kernel's two generic out-ports.
 *
 * `title@1` and `status@1` are the base contract any program may fill (`../process/self-report.ts`,
 * founder ruling R8.1 on #8715), so the shell reads a line and never an agent: a demo counter
 * filling `status@1` with its count sits on the same board as a Claude session filling it with its
 * last line. Everything backend-shaped therefore stops here — these are pure functions of the
 * committed session state, and the two lines they compose are the only thing that leaves.
 *
 * Nothing here reaches for a platform module, because the desk inspector renders a cost off
 * `agentCost` and that render runs in the browser.
 */

import {type AiAgentSessionState, usageTotals} from "./core/index.ts";
import type {TranscriptItem} from "./ports/index.ts";

/**
 * The SDK and Pi's adapter both report a currency amount already scaled to dollars, so a total
 * needs no conversion. Four fraction digits because a single turn routinely costs well under a
 * cent, and a session that reads `$0.00` after ten turns says nothing.
 */
const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});

export const agentCost = (total: number): string => money.format(total);

/** How much of a row's last line a status carries before it is cut. */
export const STATUS_LINE_LIMIT = 80;

/**
 * The folder an operator calls the session's, which is the last segment of its path.
 *
 * Split by hand rather than through `node:path`: this module is on the desk inspector's import
 * path, and that renders in the browser.
 */
const folderOf = (cwd: string): string =>
	cwd
		.split("/")
		.filter((segment) => segment.length > 0)
		.at(-1) ?? cwd;

/**
 * `program · model · cwd` (R3.1), with a segment nobody can fill left out rather than blanked — a
 * session that has not heard which model it is on yet reads `claude-session · phoenix`, not
 * `claude-session ·  · phoenix`.
 */
export const agentTitle = (program: string, state: AiAgentSessionState): string =>
	[program, state.models.current?.name ?? "", folderOf(state.cwd)]
		.filter((segment) => segment.length > 0)
		.join(" · ");

/** A tool row's own last line is its name: the result is the body, not the line the row reads as. */
const textOf = (item: TranscriptItem): string => (item.kind === "tool" ? item.name : item.text);

const cut = (line: string): string =>
	line.length > STATUS_LINE_LIMIT ? `${line.slice(0, STATUS_LINE_LIMIT - 1)}…` : line;

/**
 * The last line the session said — the newest row's own last non-empty line, cut to one line's
 * worth. Empty means the session has said nothing yet, which is a fact and not a failure.
 */
export const agentLastLine = (state: AiAgentSessionState): string => {
	const newest = state.transcript.items.at(-1);
	if (newest === undefined) return "";
	const line = textOf(newest)
		.split("\n")
		.map((candidate) => candidate.trim())
		.findLast((candidate) => candidate.length > 0);
	return line === undefined ? "" : cut(line);
};

/**
 * The session's last line and what it has spent, as the one short line `status@1` carries.
 *
 * The cost is always said and the line is not: a session mid-open has spent nothing worth reading
 * as an absence, where a status of `$0.00` alone is the honest answer before the first turn.
 */
export const agentStatus = (state: AiAgentSessionState): string =>
	[agentLastLine(state), agentCost(usageTotals(state.usage).cost)]
		.filter((part) => part.length > 0)
		.join(" · ");
