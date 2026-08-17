/**
 * How many repair rounds a PR has been through, counted by clustering FAIL markers in time.
 *
 * A gate's FAIL often arrives as several comments seconds apart, so counting comments would count one
 * round several times. The rule, pinned so two implementations agree: FAIL-polarity markers sorted by
 * `created_at` ascending; a marker whose gap from the previous FAIL **exceeds** 120 seconds starts a
 * new cluster, and a gap of **exactly** 120 seconds or less continues the current one.
 *
 * The boundary is stated because it is where the off-by-one lived (#4570), and it is counted over the
 * **full** comment set — v1 counted off a truncated 100-comment snapshot (`stepR-round-count.sh` +
 * `stepR1-verdicts.sh:48`), which under-counts exactly when the cap matters most.
 */

/** The gap at which a FAIL still belongs to the round before it. Inclusive. */
export const ROUND_GAP_MS = 120_000;

/** Cluster FAIL timestamps into rounds. An empty input is zero rounds, which is a fact, not a gap. */
export const countRounds = (createdAt: ReadonlyArray<string>): number => {
	const times = createdAt
		.map((at) => Date.parse(at))
		.filter((ms) => !Number.isNaN(ms))
		.sort((a, b) => a - b);
	let rounds = 0;
	let previous: number | null = null;
	for (const ms of times) {
		if (previous === null || ms - previous > ROUND_GAP_MS) rounds += 1;
		previous = ms;
	}
	return rounds;
};
