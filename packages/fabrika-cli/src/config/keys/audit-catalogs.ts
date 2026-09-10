/**
 * `auditCatalogs` — the repo's own smell catalogs, as repo-relative markdown paths.
 *
 * The `architecture-audit` skill ships a fixed base catalog inside its own folder and runs its
 * coverage gate over it. This key is the extension point: a repo names markdown files in the same
 * table shape and the gate emits their rows **after** the shipped ones.
 *
 * **Add-only, by construction.** The key carries paths and nothing else — there is no id to
 * re-declare and no arm that says "drop this row" — so a repo can widen the catalog and can never
 * narrow it. That is why the shipped default is the empty list rather than a populated one: empty
 * **is** the strict answer here, as it is for the other widen-only keys, and a repo that declares
 * nothing runs the gate at exactly its shipped coverage instead of inheriting another repo's smells.
 *
 * Four shapes are refused rather than repaired, because each is a catalog the gate could not read
 * while the operator believes it is configured: a path that is not a `.md` file, an absolute path,
 * a path that climbs out of the repo, and the same path twice — which would emit one catalog's rows
 * two times and make the gate's row set disagree with the file that produced it.
 */

import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const AUDIT_CATALOGS = "auditCatalogs";

const malformed = (reason: string): Decoded<ReadonlyArray<string>> => ({_tag: "Malformed", reason});

const climbs = (path: string): boolean => path.split("/").includes("..");

const decode = (raw: unknown): Decoded<ReadonlyArray<string>> => {
	if (!Array.isArray(raw)) return malformed(`\`${AUDIT_CATALOGS}\` is not an array`);

	const paths = trimmedStrings(raw);
	if (paths === null) {
		return malformed(
			`\`${AUDIT_CATALOGS}\` holds an entry that is not a non-empty string — expected a repo-relative markdown path`,
		);
	}

	const seen = new Set<string>();
	for (const path of paths) {
		if (path.startsWith("/")) {
			return malformed(
				`\`${AUDIT_CATALOGS}\` holds the absolute path \`${path}\` — expected a repo-relative markdown path`,
			);
		}
		if (climbs(path)) {
			return malformed(
				`\`${AUDIT_CATALOGS}\` holds \`${path}\`, which climbs out of the repo — expected a repo-relative markdown path`,
			);
		}
		if (!path.endsWith(".md")) {
			return malformed(
				`\`${AUDIT_CATALOGS}\` holds \`${path}\`, which is not a \`.md\` file — a smell catalog is markdown`,
			);
		}
		if (seen.has(path)) {
			return malformed(
				`\`${AUDIT_CATALOGS}\` names \`${path}\` twice — the coverage gate would emit its rows twice`,
			);
		}
		seen.add(path);
	}

	return {_tag: "Value", value: paths};
};

export const auditCatalogsKey: KeyGroup<ReadonlyArray<string>> = {
	key: AUDIT_CATALOGS,
	shippedDefault: [],
	decode,
	jsonSchema: {
		type: "array",
		description:
			"Repo-relative markdown paths holding extra smell catalogs for `architecture-audit`'s coverage gate, in the same table shape the shipped catalog uses. Add-only: their rows are emitted after the shipped rows, and no entry can remove or replace a shipped smell. Empty (or absent) means the gate runs at its shipped coverage.",
		items: {type: "string", minLength: 1, pattern: "\\.md$"},
	},
};
