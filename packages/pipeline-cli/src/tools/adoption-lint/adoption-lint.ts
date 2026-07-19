/**
 * `adoption-lint` core — the pure, IO-free matcher behind the #3254 adoption
 * corpus-lint. It flags a crew-corpus file (a SKILL.md, an agent def, an
 * orchestrator surface) that **inline-re-derives a tool-owned decision** — the
 * hand-copied ~50-line procedure that duplicates a shipped `pipeline-cli` verb's
 * logic — **instead of citing the owning verb**. This is the governing AC of epic
 * #3258: the lint lands FIRST so the verb-extraction sweep cannot grow the
 * unreferenced-tool pile (the `verdict read` / `merge-queue-classify` divergent-copy
 * class named in #3254 / #2102).
 *
 * A finding = a corpus file that matches a decision's re-derivation `signature`
 * AND does NOT match its `citation` AND is not covered by a declared exemption.
 * The declared exemptions are themselves linted (never a blanket skip, #3254):
 *  - a `mirror` exemption admits a genuinely non-importable execution surface
 *    (`.claude/workflows/drive-issue.js` cannot import the verb core at runtime);
 *    the lint verifies it exists in scope AND is structurally non-importable (not a
 *    `.md` doc, which has no excuse — it can cite the verb by contract).
 *  - a `grandfathered` exemption records an EXISTING re-derivation awaiting its
 *    sibling verb-child's same-commit migration; the lint verifies it *still*
 *    re-derives-without-citing, so once migrated the entry goes stale and FAILS,
 *    forcing its removal — the pile draws down and cannot silently rot.
 *
 * Fail-closed on zero scope (ADR 0092): the caller pairs this with `isZeroScope`,
 * which reports when no corpus file was scanned OR the manifest declares no
 * decision — either is a broken lint, a FAIL, never a silent PASS. The IO (reading
 * the corpus files) is the caller's; contents are handed in, keeping this core
 * pure and unit-testable. Signatures are non-global `RegExp`s used only with
 * `.test()`, so there is no shared-`lastIndex` statefulness to reset.
 */

/** A decision a registered `pipeline-cli` verb owns, and how to detect an inline copy of it. */
export interface OwnedDecision {
	/** The owning verb selector, e.g. `verdict read` — what a compliant file cites. */
	readonly verb: string;
	/**
	 * The re-derivation fingerprint: EVERY pattern must match the file (AND
	 * semantics) for it to count as an inline copy of the verb's procedure. An
	 * array (not one regex) so a fingerprint is the co-occurrence of several tells
	 * — precise enough that an incidental mention of one tell isn't a false finding.
	 */
	readonly signature: ReadonlyArray<RegExp>;
	/** What counts as citing the verb by contract — a match here clears the file. */
	readonly citation: RegExp;
	/** Why a signature-match-without-citation is a re-derivation (the report line). */
	readonly reason: string;
}

/** A declared, self-linted exemption from a re-derivation finding (never a blanket skip). */
export type Exemption =
	| {
			/** A genuinely non-importable execution surface, verb-agnostic (it mirrors whatever it must). */
			readonly kind: "mirror";
			readonly path: string;
			readonly reason: string;
	  }
	| {
			/** An EXISTING re-derivation of one verb, awaiting its sibling child's same-commit migration. */
			readonly kind: "grandfathered";
			readonly path: string;
			readonly verb: string;
			readonly reason: string;
	  };

export interface ScanFile {
	readonly file: string;
	readonly content: string;
}

/** A corpus file that inline-re-derives a tool-owned decision without citing the verb. */
export interface AdoptionFinding {
	readonly file: string;
	readonly verb: string;
	readonly reason: string;
}

/** A declared exemption that failed its own lint (stale / unjustified) — never a silent skip. */
export interface ExemptionFinding {
	readonly path: string;
	readonly kind: Exemption["kind"];
	readonly reason: string;
}

export interface AdoptionResult {
	/** Re-derivation-without-citation findings across the corpus. */
	readonly findings: ReadonlyArray<AdoptionFinding>;
	/** Declared exemptions that failed their own lint (stale mirror / migrated grandfather). */
	readonly exemptionFindings: ReadonlyArray<ExemptionFinding>;
	/** Every corpus file the lint considered — its scope (ADR 0092). */
	readonly scanned: ReadonlyArray<string>;
	/** Files a valid exemption cleared (reported for observability, not a failure). */
	readonly exempted: ReadonlyArray<string>;
	/** The number of tool-owned decisions the manifest declares — zero is a broken scope. */
	readonly decisionCount: number;
}

const normalize = (path: string): string => `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;

/** A path matches an exemption/decision path when it ends with the declared (normalized) suffix. */
const pathMatches = (file: string, declared: string): boolean =>
	normalize(file).endsWith(normalize(declared));

/** A `.md` is importable-by-citation: it can name the verb by contract, so it can never be a mirror. */
export const isImportableDoc = (path: string): boolean => normalize(path).endsWith(".md");

/** True iff the file inline-re-derives the decision (every signature tell matches) and never cites it. */
export const isReDerivedWithoutCitation = (content: string, decision: OwnedDecision): boolean =>
	decision.signature.every((re) => re.test(content)) && !decision.citation.test(content);

/**
 * The exemption (if any) that clears `file` for `verb`: a verb-agnostic `mirror`
 * whose path matches, or a `grandfathered` entry for exactly this verb whose path
 * matches. A grandfather for a *different* verb does not clear this one.
 */
export const exemptionFor = (
	file: string,
	verb: string,
	exemptions: ReadonlyArray<Exemption>,
): Exemption | null =>
	exemptions.find((e) => pathMatches(file, e.path) && (e.kind === "mirror" || e.verb === verb)) ??
	null;

/** Lint one declared exemption in isolation — returns the finding when it fails its own lint. */
const lintExemption = (
	exemption: Exemption,
	files: ReadonlyArray<ScanFile>,
	decisions: ReadonlyArray<OwnedDecision>,
): ExemptionFinding | null => {
	const target = files.find((f) => pathMatches(f.file, exemption.path));
	if (target === undefined) {
		return {
			path: exemption.path,
			kind: exemption.kind,
			reason: `declared ${exemption.kind} exemption names a file not in scope — stale, remove it`,
		};
	}
	if (exemption.kind === "mirror") {
		// The carve-out is only for genuinely non-importable execution surfaces; a doc can cite.
		if (isImportableDoc(exemption.path)) {
			return {
				path: exemption.path,
				kind: exemption.kind,
				reason:
					"mirror exemption must be a non-importable execution surface — a .md doc can cite the verb by contract, so it has no excuse",
			};
		}
		return null;
	}
	// grandfathered: it must STILL genuinely re-derive its verb without citing — else the sibling
	// migration already fixed it and this entry is stale, so fail to force its removal (#3254).
	const decision = decisions.find((d) => d.verb === exemption.verb);
	if (decision === undefined) {
		return {
			path: exemption.path,
			kind: exemption.kind,
			reason: `grandfathers verb '${exemption.verb}' but no decision in the manifest owns it`,
		};
	}
	if (!isReDerivedWithoutCitation(target.content, decision)) {
		return {
			path: exemption.path,
			kind: exemption.kind,
			reason: `grandfathered re-derivation of '${exemption.verb}' is gone (migrated, or the file now cites the verb) — remove this stale entry so the pile draws down`,
		};
	}
	return null;
};

/**
 * Scan the handed-in corpus for inline re-derivations of tool-owned decisions, and
 * lint the declared exemptions themselves. Returns findings, exemption findings,
 * and the two scopes the caller fails-closed on (ADR 0092).
 */
export const lintAdoption = (
	files: ReadonlyArray<ScanFile>,
	decisions: ReadonlyArray<OwnedDecision>,
	exemptions: ReadonlyArray<Exemption>,
): AdoptionResult => {
	const scanned: string[] = [];
	const exempted: string[] = [];
	const findings: AdoptionFinding[] = [];

	for (const {file, content} of files) {
		scanned.push(file);
		for (const decision of decisions) {
			if (!isReDerivedWithoutCitation(content, decision)) continue;
			if (exemptionFor(file, decision.verb, exemptions) !== null) {
				exempted.push(file);
				continue;
			}
			findings.push({file, verb: decision.verb, reason: decision.reason});
		}
	}

	const exemptionFindings: ExemptionFinding[] = [];
	for (const exemption of exemptions) {
		const finding = lintExemption(exemption, files, decisions);
		if (finding !== null) exemptionFindings.push(finding);
	}

	return {findings, exemptionFindings, scanned, exempted, decisionCount: decisions.length};
};

/**
 * Zero-scope test (ADR 0092): a lint that looked at NO corpus file, or a manifest
 * that declares NO decision, protects nothing — a FAIL, never a silent PASS. The
 * caller maps `true` to a distinct non-zero exit.
 */
export const isZeroScope = (result: AdoptionResult): boolean =>
	result.scanned.length === 0 || result.decisionCount === 0;
