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
/**
 * The render harness config as this package ships it; absent means this repo declares no headless
 * render path (`19`).
 *
 * Unlike its neighbours this one is a **default**, not a fixed convention: where a repo keeps it is
 * `designHarness` in `.fabrika.jsonc` (`../config/keys/paths.ts`), which the three `ui` verbs
 * resolve before they probe. Re-exported from that key's module so the string is written once.
 */
export {SHIPPED_DESIGN_HARNESS as HARNESS_PATH} from "../config/keys/paths.ts";
/** The golden pointer, in probe order: the package-local file first, the root fallback second. */
export const GOLDEN_POINTER_PATHS: ReadonlyArray<string> = [
	"packages/design-capture/golden-pointer.json",
	"design-goldens.json",
];

/** Join a repo-root-relative convention path onto the resolved root. */
export const atRoot = (root: string, relative: string): string =>
	`${root.replace(/\/+$/, "")}/${relative}`;
