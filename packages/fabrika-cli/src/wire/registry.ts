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
 */
import * as acceptanceCriteria from "./acceptance-criteria.ts";
import type {WireFormat} from "./format.ts";
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
	},
	{
		key: "verdict-marker",
		purpose:
			"the SHA-bound first line of a gate's verdict comment on a PR — namespace, polarity, the head the reviewer inspected, and the human clause",
		producers: ["review"],
		consumers: ["build", "ship"],
		emit: verdictMarker.emitFromFields,
		read: verdictMarker.readToLines,
	},
];

/** The registered key for `--format`, resolved against the array above. `undefined` is zero scope. */
export const findFormat = (key: string): WireFormat | undefined =>
	registeredFormats.find((format) => format.key === key);

/** Every registered key, for a refusal that names what *is* available. */
export const registeredKeys = (): ReadonlyArray<string> =>
	registeredFormats.map((format) => format.key);
