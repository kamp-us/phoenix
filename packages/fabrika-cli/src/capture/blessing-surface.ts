/**
 * The blessing surface (epic #2955 stories 2/9, issue #2962, ADR 0183 §5): the
 * human-in-the-loop bless → commit path on top of the candidate set (#2961) and the
 * golden pointer (#2960). It renders the founder-facing GitHub gallery comment from a
 * candidate set, and folds the founder's per-surface approve/redline verdicts into a
 * golden-pointer move — blessing the approved candidates, leaving the redlined ones out.
 *
 * Load-bearing guard (ADR 0183 §5, "commit the EXACT approved bytes — no re-render"):
 * a bless is a POINTER MOVE, never a re-render. `applyBlessing` takes each blessed
 * surface's `sha256` ONLY from the candidate set the founder saw in the gallery — the
 * `BlessDecision` carries a verdict, never a sha — so the committed content-address is
 * provably the one the founder approved. depo's write-once immutability is then the
 * "explicit update, never silent overwrite" guarantee (story 9) for free.
 *
 * Pure + IO-free: gallery render, decision parse, and blessing fold are all
 * deterministic (unit-tested — same inputs → same output). The fs/pointer boundary is
 * `golden-fs.ts`; the depo boundary is `golden-store.ts`; this module touches neither.
 */

import type {CandidateScreen, CandidateSet} from "./candidate-set.ts";
import {blessSurface, type GoldenPointer} from "./golden-pointer.ts";

/** The founder's per-surface verdict: bless it into the golden set, or leave it out. */
export type BlessVerdict = "approve" | "redline";

/** One founder decision — which surface, and whether it is blessed. Carries NO sha. */
export interface BlessDecision {
	readonly surfaceId: string;
	readonly verdict: BlessVerdict;
}

/** A surface that was blessed this session, with the exact sha the pointer moved to. */
export interface BlessedSurface {
	readonly surfaceId: string;
	readonly sha256: string;
}

/** The outcome of a blessing session: the new pointer + what was blessed vs redlined. */
export interface BlessingResult {
	/** The golden pointer after moving each approved surface to its candidate sha. */
	readonly pointer: GoldenPointer;
	/** Surfaces blessed this session (approved), in candidate-set (founder) order. */
	readonly blessed: readonly BlessedSurface[];
	/** Surface-ids redlined this session (left out of the golden set), in order. */
	readonly redlined: readonly string[];
}

/**
 * Render the founder-facing blessing gallery — the GitHub comment (ADR 0183 §5,
 * option a). One section per candidate in founder order, embedding the depo URL at
 * full resolution, and a copy-paste decision template the operator marks and feeds
 * back to `applyBlessing` (via `parseBlessDecisions`). Deterministic: forced-flag
 * provenance is key-sorted so the same set always renders byte-identically.
 */
export const renderBlessingGallery = (set: CandidateSet): string => {
	const flagKeys = Object.keys(set.forcedFlags).sort();
	const flags =
		flagKeys.length === 0
			? "(none)"
			: flagKeys.map((k) => `\`${k}=${set.forcedFlags[k] ? "on" : "off"}\``).join(", ");

	const sections = set.screens.map((screen) => {
		return [
			`### ${screen.order}. ${screen.title}`,
			`- surface: \`${screen.surfaceId}\``,
			`- intent: ${screen.intent}`,
			`- golden sha256: \`${screen.sha256}\``,
			"",
			`![${screen.title}](${screen.url})`,
		].join("\n");
	});

	// The template intentionally ships the placeholder `approve|redline`, not a default:
	// a copy-paste without editing fails loud in parseBlessDecisions, forcing a real
	// per-surface decision rather than silently blessing (or dropping) a surface.
	const template = set.screens.map((screen) => `${screen.surfaceId}	approve|redline`).join("\n");

	return [
		"## Golden blessing gallery",
		"",
		`Preview: ${set.previewUrl} · viewport: \`${set.viewport}\` · forced flags: ${flags}`,
		`${set.screens.length} candidate surface(s) staged for blessing (ADR 0183 §5).`,
		"",
		"For each surface below, decide **approve** (bless into the golden set) or **redline** (leave it out). The blessed golden is committed at the exact `sha256` shown — no re-render between what you see and what is committed.",
		"",
		sections.join("\n\n"),
		"",
		"---",
		"### Decision template",
		"Copy the block, replace each `approve|redline` with your verdict, and feed it to `golden-bless-set --decisions`:",
		"",
		"```",
		template,
		"```",
		"",
	].join("\n");
};

const VERDICTS: Readonly<Record<string, BlessVerdict>> = {approve: "approve", redline: "redline"};

/**
 * Parse a founder decisions block (the filled-in gallery template) into decisions.
 * Each meaningful line is `<surfaceId> <verdict>` (whitespace-separated); blank lines,
 * `#` comments, and ``` fence lines are ignored so the raw copied template block parses
 * as-is. A malformed line or an unrecognized verdict (e.g. the un-replaced
 * `approve|redline` placeholder) fails loud — an ambiguous verdict must never silently
 * bless or drop a surface.
 */
export const parseBlessDecisions = (text: string): readonly BlessDecision[] => {
	const decisions: BlessDecision[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#") || line.startsWith("```")) continue;
		const tokens = line.split(/\s+/);
		if (tokens.length !== 2) {
			throw new Error(
				`blessing-surface: decision line must be "<surfaceId> <approve|redline>", got: "${line}"`,
			);
		}
		const [surfaceId, rawVerdict] = tokens as [string, string];
		const verdict = VERDICTS[rawVerdict.toLowerCase()];
		if (verdict === undefined) {
			throw new Error(
				`blessing-surface: verdict for "${surfaceId}" must be approve|redline, got: "${rawVerdict}"`,
			);
		}
		decisions.push({surfaceId, verdict});
	}
	return decisions;
};

export interface ApplyBlessingInput {
	readonly set: CandidateSet;
	readonly decisions: readonly BlessDecision[];
	/** ISO date (YYYY-MM-DD) stamped onto each blessed pointer entry. */
	readonly blessedDate: string;
	/** The current golden pointer a re-bless updates in place (empty on first bless). */
	readonly pointer: GoldenPointer;
}

/**
 * Fold the founder's verdicts into a golden-pointer move: bless (pointer-move) every
 * approved surface to its candidate `sha256`, leave the redlined ones out, and return
 * the new pointer. Every candidate must carry exactly one decision — an unaddressed
 * candidate, a decision for a surface not in the set, and a duplicate decision all fail
 * closed, so a partial/ambiguous blessing can never be committed.
 *
 * The blessed `sha256` and `intent` come from the candidate SCREEN, never from the
 * decision — this is the ADR 0183 §5 no-re-render guard made structural: the pointer
 * can only move to a content-address the founder actually saw in the gallery. A
 * re-bless is exactly the same fold over a non-empty `pointer` (a redlined surface's
 * existing golden is left untouched — a redline is "not re-blessed", not "removed").
 */
export const applyBlessing = (input: ApplyBlessingInput): BlessingResult => {
	const screens = new Map<string, CandidateScreen>();
	for (const screen of input.set.screens) {
		screens.set(screen.surfaceId, screen);
	}

	const verdicts = new Map<string, BlessVerdict>();
	for (const decision of input.decisions) {
		if (!screens.has(decision.surfaceId)) {
			throw new Error(
				`blessing-surface: decision for "${decision.surfaceId}" — no such candidate in the set`,
			);
		}
		if (verdicts.has(decision.surfaceId)) {
			throw new Error(`blessing-surface: duplicate decision for "${decision.surfaceId}"`);
		}
		verdicts.set(decision.surfaceId, decision.verdict);
	}

	const unaddressed = input.set.screens
		.filter((s) => !verdicts.has(s.surfaceId))
		.map((s) => s.surfaceId);
	if (unaddressed.length > 0) {
		throw new Error(
			`blessing-surface: every candidate needs an approve/redline verdict — missing: ${unaddressed.join(", ")}`,
		);
	}

	let pointer = input.pointer;
	const blessed: BlessedSurface[] = [];
	const redlined: string[] = [];
	for (const screen of input.set.screens) {
		if (verdicts.get(screen.surfaceId) === "approve") {
			pointer = blessSurface(pointer, {
				surfaceId: screen.surfaceId,
				sha256: screen.sha256,
				blessedDate: input.blessedDate,
				intent: screen.intent,
			});
			blessed.push({surfaceId: screen.surfaceId, sha256: screen.sha256});
		} else {
			redlined.push(screen.surfaceId);
		}
	}

	return {pointer, blessed, redlined};
};
