/**
 * Where a repo's design surfaces live — **filename conventions, not one repo's facts**.
 *
 * This group reads whatever repo it runs in, and no repo is privileged. v1 fetched the manifest from
 * a hardcoded GitHub URL, which reads the wrong repo's law in any fork and nothing at all on a
 * network fault; here the law is the tree's own bytes.
 */

/** The design manifest — the one surface whose absence refuses (`12`). */
export const MANIFEST_PATH = "design-system-manifest.md";
/** The typed prohibition registry; absent means the law is untyped (`13`), never an error. */
export const REGISTRY_PATH = "design-prohibitions.json";
/** The component inventory; absent is a fact reported as `null`. */
export const INVENTORY_PATH = "design-system-inventory.md";
/** The golden pointer, in probe order: the package-local file first, the root fallback second. */
export const GOLDEN_POINTER_PATHS: ReadonlyArray<string> = [
	"packages/design-capture/golden-pointer.json",
	"design-goldens.json",
];

/** Join a repo-root-relative convention path onto the resolved root. */
export const atRoot = (root: string, relative: string): string =>
	`${root.replace(/\/+$/, "")}/${relative}`;
