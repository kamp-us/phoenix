/**
 * The wire-format registry — the extension seam.
 *
 * One row per format: its `--format` key, its purpose, who writes the bytes, who reads them, and
 * the schema module that owns them. `fabrika wire formats` derives its listing from this array, and
 * `emit` / `read` / `check` resolve `--format` against it, so a format exists by being registered
 * here and nowhere else. That is the same discipline `../registry.ts` holds for verb groups, for
 * the same reason: a hand-maintained parallel list is a second source of truth that drifts, and the
 * drift is silent.
 *
 * A new format lands as a sibling schema module plus one row here — never as a branch inside a
 * verb.
 *
 * A row also carries what `./conformance.ts` judges it by: the fixtures its laws are driven from and
 * the brands its value is built from. Both are required by {@link WireFormat}, so a format cannot be
 * registered without them — which is what makes the totality law inherited rather than re-written.
 */
import * as acceptanceCriteria from "./acceptance-criteria.ts";
import {brandWitnesses, type WireFormat} from "./format.ts";
import * as verdictMarker from "./verdict-marker.ts";

export const registeredFormats: ReadonlyArray<WireFormat> = [
	{
		key: "acceptance-criteria",
		purpose:
			"the checkbox contract a gate grades a PR against, carried on a sub-issue body under `### Acceptance criteria`",
		producers: ["triage", "build-epic"],
		consumers: ["build", "review"],
		emit: acceptanceCriteria.emitFromFields,
		read: acceptanceCriteria.readToLines,
		fixtures: {
			roundTrip: {
				fields: "- [ ] the read is total\n- [x] the registry is the seam\n",
				values: ["the read is total", "the registry is the seam"],
			},
			absent: "### What to build\n\nStand up the group. Nothing here reaches for the block.\n",
			malformed: [
				{
					drift: "the heading spelling drifted",
					artifact: "### Acceptance Criteria\n- [ ] one\n- [ ] two\n",
				},
				{
					drift: "the heading level drifted",
					artifact: "#### Acceptance criteria\n- [ ] one\n",
				},
				{
					drift: "the conforming heading is present over prose instead of checkbox items",
					artifact: "### Acceptance criteria\n\nEvery box is implied.\n",
				},
			],
		},
		brands: brandWitnesses<acceptanceCriteria.AcceptanceCriterion>({text: true}),
	},
	{
		key: "verdict-marker",
		purpose:
			"the SHA-bound first line of a gate's verdict comment on a PR — namespace, polarity, the head the reviewer inspected, and the human clause",
		producers: ["review"],
		consumers: ["build", "ship"],
		emit: verdictMarker.emitFromFields,
		read: verdictMarker.readToLines,
		fixtures: {
			roundTrip: {
				fields: "namespace: review-code\npolarity: PASS\nsha: 03135b91\nclause: merge-ready\n",
				values: ["review-code", "PASS", "03135b91", "merge-ready"],
			},
			absent: "Thanks — this reads well to me, no notes.\n",
			malformed: [
				{
					drift: "the namespace is not kebab-case",
					artifact: "review_code: PASS @ 03135b91 — merge-ready\n",
				},
				{
					drift: "the marker is bound to no head SHA",
					artifact: "review-code: PASS — merge-ready\n",
				},
				{
					drift: "the polarity is not PASS or FAIL",
					artifact: "review-code: APPROVED @ 03135b91 — merge-ready\n",
				},
			],
		},
		brands: brandWitnesses<verdictMarker.VerdictMarker>({sha: true, clause: true, polarity: true}),
	},
];

/** The registered key for `--format`, resolved against the array above. `undefined` is zero scope. */
export const findFormat = (key: string): WireFormat | undefined =>
	registeredFormats.find((format) => format.key === key);

/** Every registered key, for a refusal that names what *is* available. */
export const registeredKeys = (): ReadonlyArray<string> =>
	registeredFormats.map((format) => format.key);
