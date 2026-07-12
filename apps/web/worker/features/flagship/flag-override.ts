/**
 * Runtime flag-override domain (admin-console epic #2711, #2741). Pure logic, no I/O: the
 * current runtime override for a flag is a PROJECTION of the append-only
 * `flag_override_event` log — the latest event decides, so the effective override can never
 * drift from the audit history and a stale "forced-on flag" is unrepresentable. This mirrors
 * `resolveBanState` (`ban.ts`) / `resolveEmailDeliveryState` (`email-delivery.ts`) verbatim:
 * a projection over an append-only log.
 *
 * The override wraps `Flags.getBoolean` (`Flags.ts` `withRuntimeOverrides`): a key whose
 * latest event is `on`/`off` short-circuits to that forced value; a `clear` (or no events)
 * projects to `undefined` and the read delegates to the real Flagship evaluation — so a
 * Flagship outage still degrades to the caller's safe default (the override never turns the
 * never-throwing flag contract fail-open, epic #2711 story 8).
 */

/** The tri-state an admin flip appends: force `on`/`off`, or `clear` the override. */
export type FlagOverrideAction = "on" | "off" | "clear";

/** One row of the append-only override log, as the projection needs it. */
export interface FlagOverrideEvent {
	readonly action: FlagOverrideAction;
	readonly createdAt: Date;
}

/**
 * Project a flag's effective runtime override from its LATEST event.
 *
 * The caller passes the single newest event (by `createdAt`) or null when the log is empty.
 * `on` → `true`, `off` → `false` — the forced effective value; `clear` (or no events) →
 * `undefined`, meaning "no override, read the real evaluation". `undefined` is the load-bearing
 * absence signal the wrapper delegates on, distinct from a forced-`false` override.
 */
export const resolveFlagOverride = (latest: FlagOverrideEvent | null): boolean | undefined => {
	if (latest === null || latest.action === "clear") return undefined;
	return latest.action === "on";
};

/**
 * One append-only log row as the admin flag-state roll-up (#2741) needs it: the projection
 * fields plus the flag key the row is keyed by and the server `id`/`createdAt` ordering pair
 * used to pick the latest event per flag.
 */
export interface FlagOverrideEventRow extends FlagOverrideEvent {
	readonly id: string;
	readonly flagKey: string;
}

// Latest wins by (createdAt, id) — the same server-assigned ordering the ban/email reads and
// the per-key index (`flag_override_event_key_created`) resolve by, so the pure roll-up and a
// DB `ORDER BY … DESC LIMIT 1` per key agree.
const isNewer = (a: FlagOverrideEventRow, b: FlagOverrideEventRow): boolean => {
	const at = a.createdAt.getTime();
	const bt = b.createdAt.getTime();
	return at !== bt ? at > bt : a.id > b.id;
};

/**
 * The active-overrides projection (#2741): the map of flag key → forced boolean for every key
 * whose LATEST event is `on`/`off`, derived from the SAME append-only log the per-key
 * `resolveFlagOverride` read uses — never a separate stored flag. Reduces the rows to the newest
 * event per key and keeps those that project to a defined override (a `clear`-latest key is
 * absent from the map, so it reads the real evaluation). Pure over the full override log (small —
 * only admin flips land here), so the roll-up is unit-testable without D1.
 */
export const selectActiveOverrides = (
	rows: ReadonlyArray<FlagOverrideEventRow>,
): ReadonlyMap<string, boolean> => {
	const latest = new Map<string, FlagOverrideEventRow>();
	for (const row of rows) {
		const seen = latest.get(row.flagKey);
		if (!seen || isNewer(row, seen)) latest.set(row.flagKey, row);
	}
	const active = new Map<string, boolean>();
	for (const [key, row] of latest) {
		const override = resolveFlagOverride(row);
		if (override !== undefined) active.set(key, override);
	}
	return active;
};
