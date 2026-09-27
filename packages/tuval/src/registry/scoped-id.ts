/**
 * The grammar of a project-scoped id (#9684): `<scope>/<local>`. A program row or graph node that a
 * project's config declares runs under its project's scope, and a row the global config or the desk
 * declares keeps its bare id, so a project row and a global row with one local id sit side by side.
 *
 * The separator is reserved: the loader refuses a declared id that carries one, which is what makes
 * the split below exact. The desk's loader owns which scope an id gets; this module only reads and
 * writes the grammar, so a program that baked its own local id into a closure can still find itself
 * under whatever scope it was registered at.
 */

export const SCOPE_SEPARATOR = "/";

/** An id split at its first separator. `scope` is absent for a bare id. */
export interface ScopedIdParts {
	readonly scope: string | undefined;
	readonly local: string;
}

export const scopedId = (scope: string, local: string): string =>
	`${scope}${SCOPE_SEPARATOR}${local}`;

export const scopedIdParts = (id: string): ScopedIdParts => {
	const at = id.indexOf(SCOPE_SEPARATOR);
	return at < 0 ? {scope: undefined, local: id} : {scope: id.slice(0, at), local: id.slice(at + 1)};
};

/** The id a row was declared under, before any scope was put in front of it. */
export const localId = (id: string): string => scopedIdParts(id).local;
