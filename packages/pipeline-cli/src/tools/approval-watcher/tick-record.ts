/**
 * `approval-watcher` core — the durable tick record's shape, its disposition vocabulary,
 * and the coalescing write plan. Pure and IO-free; `github.ts` supplies the `gh api` REST
 * shell and `command.ts` the Effect bin.
 *
 * The §CP approval-watcher used to end every branch of a tick in an `echo` to the running
 * agent's transcript, which is session-local. From outside, a loop that never ticked and a loop that ticked and found nothing
 * were the same observation — silence — so an investigation into a watcher that is not firing
 * cannot discriminate a cadence defect from a derivation defect (#4292, blocking #4290).
 *
 * Two properties carry the whole design:
 *
 *  - **A tick that finds nothing is as visible as one that fires.** The record always carries the
 *    tick's *derived watch set*, and an empty set is recorded AS an empty set — a state distinct
 *    from the absence of a record, which is the only thing that means "no tick ran".
 *  - **fired / definite-stop / unknown never collapse.** The watcher's own spec draws that
 *    three-way distinction (a read that could not execute is UNKNOWN, never "no approval") and the
 *    record preserves it per PR — see `parseDisposition` for how that survives a token it cannot read.
 *
 * The same distinction holds one level up, over the *cardinality* of the set: see `Derivation`.
 */

/** One PR's outcome in a tick — the three-way distinction the watcher spec draws, preserved. */
export type Disposition =
	| {readonly _tag: "fired"}
	| {readonly _tag: "definite-stop"; readonly reason: string}
	| {readonly _tag: "unknown"; readonly input: string};

/**
 * How the tick's watch set came to be — the SET-LEVEL analog of `Disposition`'s `unknown`, and the
 * reason a record can say "I could not derive the set" rather than asserting a board it never read.
 *
 * The board re-derivation is a `gh api` read like every input inside the guards, and an unproven one
 * expands to nothing: without this state an outage and a genuinely empty board write the identical
 * record, so the strongest derivation-defect signal a reader has would be forgeable by a 503.
 */
export type Derivation =
	| {readonly _tag: "derived"}
	| {readonly _tag: "unresolved"; readonly input: string};

/** One member of the tick's derived watch set, with the disposition that tick reached for it. */
export interface WatchEntry {
	readonly pr: number;
	readonly disposition: Disposition;
}

/**
 * One durable tick record. `ticks` > 1 means consecutive ticks that derived the *same* set with
 * the *same* dispositions were coalesced into this record (see `planTickWrite`) — `firstAt` and
 * `lastAt` then bound the run, which is what makes cadence readable without a comment per tick.
 */
export interface TickRecord {
	readonly firstAt: string;
	readonly lastAt: string;
	readonly ticks: number;
	readonly sessions: ReadonlyArray<string>;
	readonly watch: ReadonlyArray<WatchEntry>;
	/** Watch-set entries that did not parse, kept verbatim — never silently dropped. */
	readonly malformed: ReadonlyArray<string>;
	/** Whether the set above IS the board, or the board read never executed. */
	readonly derivation: Derivation;
}

export const formatDisposition = (d: Disposition): string => {
	switch (d._tag) {
		case "fired":
			return "fired";
		case "definite-stop":
			return `definite-stop:${d.reason}`;
		case "unknown":
			return `unknown:${d.input}`;
	}
};

/**
 * Total, and deliberately biased toward `unknown`. A token this cannot read is a token whose meaning
 * was never established, which is exactly `unknown` — reading it as a definite stop would manufacture
 * the false-definite the watcher's guards exist to prevent (#3715, #4108, #4171, #4204, #4270).
 */
export const parseDisposition = (raw: string): Disposition => {
	const token = raw.trim();
	if (token === "fired") return {_tag: "fired"};
	if (token.startsWith("definite-stop:")) {
		const reason = token.slice("definite-stop:".length).trim();
		return reason === ""
			? {_tag: "unknown", input: "definite-stop with no reason"}
			: {_tag: "definite-stop", reason};
	}
	if (token.startsWith("unknown:")) {
		const input = token.slice("unknown:".length).trim();
		return {_tag: "unknown", input: input === "" ? "unnamed input" : input};
	}
	return {_tag: "unknown", input: `unrecognized disposition ${JSON.stringify(token)}`};
};

export const formatDerivation = (d: Derivation): string =>
	d._tag === "derived" ? "derived" : `unresolved:${d.input}`;

/**
 * Total, and biased toward `unresolved` for the same reason `parseDisposition` is biased toward
 * `unknown`: a token this cannot read never established that the board WAS read, and only a proven
 * read may claim the set is the board's.
 */
export const parseDerivation = (raw: string): Derivation => {
	const token = raw.trim();
	if (token === "derived") return {_tag: "derived"};
	if (token.startsWith("unresolved:")) {
		const input = token.slice("unresolved:".length).trim();
		return {_tag: "unresolved", input: input === "" ? "unnamed input" : input};
	}
	return {_tag: "unresolved", input: `unrecognized derivation ${JSON.stringify(token)}`};
};

/** What a watch-set spec parsed to: the entries it named, and the lines it could not read. */
export interface WatchSpec {
	readonly entries: ReadonlyArray<WatchEntry>;
	readonly malformed: ReadonlyArray<string>;
}

/**
 * Parse the `--watch` spec the watcher shell accumulates: one `<pr>=<disposition>` per line
 * (`;` also separates, for a one-liner). The separator is `=` because a disposition carries its
 * own `:` (`unknown:reviews`).
 *
 * An EMPTY spec is a valid, meaningful input — the tick derived an empty watch set — so it
 * parses to zero entries rather than an error. That is the state the record must be able to
 * express: `--watch ""` is a tick that looked and found nothing, and the flag is required at the
 * CLI so omitting it cannot forge one.
 */
export const parseWatchSpec = (spec: string): WatchSpec => {
	const entries: Array<WatchEntry> = [];
	const malformed: Array<string> = [];
	for (const line of spec.split(/[\n;]/)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const at = trimmed.indexOf("=");
		const prRaw = (at === -1 ? trimmed : trimmed.slice(0, at)).trim().replace(/^#/, "");
		const pr = Number(prRaw);
		if (at === -1 || !Number.isInteger(pr) || pr <= 0) {
			malformed.push(trimmed);
			continue;
		}
		entries.push({pr, disposition: parseDisposition(trimmed.slice(at + 1))});
	}
	entries.sort((a, b) => a.pr - b.pr);
	return {entries, malformed};
};

/**
 * The coalescing key: the derivation state, the derived set and its dispositions — and nothing
 * time- or session-varying. Keying on the derivation too is what stops a run of failed board reads
 * from folding into a healthy record's "empty board" span.
 * Two consecutive ticks with the same digest say the same thing, so they fold into one record
 * with a bumped count instead of two comments — the noise budget that lets a per-tick record ride
 * a self-drain loop at all.
 */
export const digestOf = (
	watch: ReadonlyArray<WatchEntry>,
	malformed: ReadonlyArray<string>,
	derivation: Derivation,
): string =>
	[
		`@${formatDerivation(derivation)}`,
		...[...watch]
			.sort((a, b) => a.pr - b.pr)
			.map((e) => `${e.pr}=${formatDisposition(e.disposition)}`),
		...[...malformed].sort().map((m) => `!${m}`),
	].join(";");

/** The line a reader greps for, and `parseTick` keys on. */
const MARKER = "approval-watcher-tick";
const FENCE_RE = /```json\n([\s\S]*?)\n```/;

const headline = (record: TickRecord): string => {
	const span =
		record.ticks === 1
			? `1 tick · ${record.firstAt}`
			: `${record.ticks} ticks · ${record.firstAt} → ${record.lastAt}`;
	const seen =
		record.watch.length === 0 ? "" : ` (${record.watch.length} PR(s) reached before it failed)`;
	const set =
		record.derivation._tag === "unresolved"
			? `derived watch set UNRESOLVED: ${record.derivation.input}${seen} — the board read did not execute, so this is NOT an empty board`
			: record.watch.length === 0
				? "derived watch set EMPTY (no banked §CP PR awaiting approval) — a tick ran and found nothing"
				: `${record.watch.length} PR(s) in the derived watch set`;
	return `${MARKER}: ${span} · ${set}`;
};

/** The comment body: a human-scannable head, then the machine payload `parseTick` reads back. */
export const renderTick = (record: TickRecord): string => {
	const rows =
		record.watch.length === 0
			? [
					record.derivation._tag === "unresolved"
						? "_(the watch set could not be derived — recorded as UNRESOLVED, which is neither an empty set nor a missing record)_"
						: "_(empty set — recorded as an empty set, which is not the same as no tick)_",
				]
			: [
					"| PR | disposition |",
					"| --- | --- |",
					...record.watch.map((e) => `| #${e.pr} | \`${formatDisposition(e.disposition)}\` |`),
				];
	const malformed =
		record.malformed.length === 0
			? []
			: ["", `Unreadable watch-set entries (kept verbatim): ${record.malformed.join(", ")}`];
	return [
		headline(record),
		"",
		...rows,
		...malformed,
		"",
		"```json",
		JSON.stringify({
			...record,
			derivation: formatDerivation(record.derivation),
			digest: digestOf(record.watch, record.malformed, record.derivation),
		}),
		"```",
	].join("\n");
};

type RawRecord = Omit<TickRecord, "derivation"> & {readonly derivation?: unknown};

const isRecordShape = (value: unknown): value is RawRecord => {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.firstAt === "string" &&
		typeof v.lastAt === "string" &&
		typeof v.ticks === "number" &&
		Array.isArray(v.sessions) &&
		Array.isArray(v.watch) &&
		Array.isArray(v.malformed)
	);
};

/**
 * Read a tick record back out of a comment body; `null` for any comment that is not one.
 *
 * A payload carrying no derivation state reads `unresolved`, never `derived` — a record whose writer
 * had no way to say "the board read failed" cannot be taken to have proven it succeeded.
 */
export const parseTick = (body: string): TickRecord | null => {
	if (!body.includes(MARKER)) return null;
	const fenced = FENCE_RE.exec(body);
	if (fenced?.[1] === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(fenced[1]);
		if (!isRecordShape(parsed)) return null;
		const {firstAt, lastAt, ticks, sessions, watch, malformed, derivation} = parsed;
		return {
			firstAt,
			lastAt,
			ticks,
			sessions,
			watch,
			malformed,
			derivation:
				typeof derivation === "string"
					? parseDerivation(derivation)
					: {_tag: "unresolved", input: "no derivation state in the record"},
		};
	} catch {
		return null;
	}
};

/** One tick as the CLI hands it to the planner, before coalescing decides how it lands. */
export interface TickInput {
	readonly at: string;
	readonly session: string;
	readonly watch: ReadonlyArray<WatchEntry>;
	readonly malformed: ReadonlyArray<string>;
	readonly derivation: Derivation;
}

/** Post a new record, or fold this tick into the newest one because it says the same thing. */
export type TickWrite =
	| {readonly _tag: "post"; readonly record: TickRecord; readonly body: string}
	| {
			readonly _tag: "coalesce";
			readonly commentId: number;
			readonly record: TickRecord;
			readonly body: string;
	  };

/** The newest existing tick record on the ledger, if the ledger carries one. */
export interface LatestTick {
	readonly commentId: number;
	readonly record: TickRecord;
}

/**
 * Decide how a tick lands. Coalescing is CONSECUTIVE-run only: it folds into the newest record and
 * only when the digests match, so a set that changes and later changes back opens a new record
 * rather than rewriting history out of order.
 */
export const planTickWrite = (latest: LatestTick | null, tick: TickInput): TickWrite => {
	const digest = digestOf(tick.watch, tick.malformed, tick.derivation);
	if (
		latest !== null &&
		digestOf(latest.record.watch, latest.record.malformed, latest.record.derivation) === digest
	) {
		const record: TickRecord = {
			firstAt: latest.record.firstAt,
			lastAt: tick.at,
			ticks: latest.record.ticks + 1,
			sessions: [...new Set([...latest.record.sessions, tick.session])],
			watch: tick.watch,
			malformed: tick.malformed,
			derivation: tick.derivation,
		};
		return {_tag: "coalesce", commentId: latest.commentId, record, body: renderTick(record)};
	}
	const record: TickRecord = {
		firstAt: tick.at,
		lastAt: tick.at,
		ticks: 1,
		sessions: [tick.session],
		watch: tick.watch,
		malformed: tick.malformed,
		derivation: tick.derivation,
	};
	return {_tag: "post", record, body: renderTick(record)};
};
