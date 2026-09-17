/**
 * The one string the kernel half and the browser half have to agree on, in the one file both may
 * import.
 *
 * `./cron.ts` puts this on the row and never sees React; `./window.tsx` is what the string names
 * and never sees the kernel. A `kind: "module"` reference is a *module specifier* the desk's page
 * imports at boot (ADR 0359 in kamp-us/phoenix), so the string is this package's own `./window`
 * entry point — which is why it is a constant here rather than something a config author has to
 * know and spell right.
 *
 * `RendererRef` is reproduced structurally instead of imported: Tuval's row type lives in
 * `apps/tuval/src/registry/program.ts` and is not on any of the published doors, so an external
 * package cannot name it. Every field is copied from that file, so an object typed here is
 * assignable there.
 */

export type RendererKind =
  | "host-native"
  | "host-declarative"
  | "isolated-frame"
  | "module";

/** A reference only: the kernel stores it and reports it, and never renders anything itself. */
export interface RendererRef {
  readonly kind: RendererKind;
  readonly ref: string;
}

/**
 * Where a desk finds this program's window. The page resolves this specifier **from the config
 * module that declared the row** (#8262), not from the app — so `@kampus/tuval-cron` has to be
 * installed beside `tuval.config.ts`, and a specifier that resolves from neither there nor the page
 * root refuses the page at boot naming this string.
 */
export const CRON_WINDOW_REF: RendererRef = {
  kind: "module",
  ref: "@kampus/tuval-cron/window",
};
