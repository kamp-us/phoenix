/**
 * Where a repo's design surfaces live — **filename conventions, not phoenix facts**.
 *
 * The portability ruling on #4941: this group reads whatever repo it runs in, and phoenix is one
 * instance. v1 fetched the manifest from a hardcoded GitHub URL, which reads the wrong repo's law in
 * any fork and nothing at all on a network fault; here the law is the tree's own bytes.
 */

/** The design manifest — the one surface whose absence refuses (`12`). */
export const MANIFEST_PATH = "design-system-manifest.md";
/** The typed prohibition registry; absent means the law is untyped (`13`), never an error. */
export const REGISTRY_PATH = "design-prohibitions.json";
/** The component inventory; absent is a fact reported as `null`. */
export const INVENTORY_PATH = "design-system-inventory.md";
/** The render harness config; absent means this repo declares no headless render path (`19`). */
export const HARNESS_PATH = "design-harness.json";
/** The golden pointer, in probe order: the package-local file first, the root fallback second. */
export const GOLDEN_POINTER_PATHS: ReadonlyArray<string> = [
	"packages/design-capture/golden-pointer.json",
	"design-goldens.json",
];

/** Join a repo-root-relative convention path onto the resolved root. */
export const atRoot = (root: string, relative: string): string =>
	`${root.replace(/\/+$/, "")}/${relative}`;
