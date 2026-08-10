/**
 * The bytes `glossary init` writes.
 *
 * **No section is scaffolded.** An empty section invites filler; `add --create-section` writes the
 * first one together with the row that justifies it.
 */
import type {RegisterName} from "./register.ts";

/** The register file a fresh repo starts from, for the repo directory named `repo`. */
export const registerTemplate = (repo: string, register: RegisterName): string =>
	register === "terms"
		? `# ${repo} domain vocabulary (TERMS)

The repo-owned vocabulary spine. One row per term: the canonical definition, and where a name has
drifted, what the term is **not**. When the code and this file disagree, the code is authoritative
and this file is the doc to fix.
`
		: `# ${repo} architecture vocabulary (LANGUAGE)

The repo-owned architecture vocabulary. One row per term: the canonical definition, and where a name
has drifted, what the term is **not**. When the code and this file disagree, the code is
authoritative and this file is the doc to fix.
`;
