/**
 * Vite resolves a `.css` side-effect import to a module that injects the stylesheet; TypeScript has
 * no idea what a `.css` file is. Declared here rather than by pulling in `vite/client`, which would
 * also add `import.meta.env` and the rest of the bundler's ambient surface to every file in the app.
 */
declare module "*.css" {
	const url: string;
	export default url;
}

/**
 * The page server's generated loader module (`./dev-server.ts`, ADR 0359): one `import()` thunk per
 * `kind: "module"` renderer reference the booted rows declared, keyed by the reference. Declared
 * here for the same reason `*.css` is — Vite knows the module, TypeScript does not.
 */
declare module "virtual:tuval/module-renderers" {
	const loaders: Readonly<Record<string, () => Promise<unknown>>>;
	export default loaders;
}

/**
 * The page server's generated feature-flag module (`./dev-server.ts`, #8439): the booted config's
 * flags, every one resolved to a boolean, so `./renderers.tsx` builds each chat renderer at the
 * operator's flags with no async step.
 *
 * The shape is `TuvalFeatures` itself, read from `../features.ts` — the node-free module that owns
 * it — and never from `../config.ts`, which merges the layers and imports `node:*`: this file is in
 * `tsconfig.browser.json`'s two-file `include`, so naming `config.ts` here drags it into a project
 * compiled with `types: []` and reds on the `node:` specifiers.
 *
 * It is an `import(…)` type rather than a top-level import because a `.d.ts` carrying one of those
 * stops being ambient, and every `declare module` in it turns into an augmentation of a module that
 * does not exist. Being a type position, it is also no runtime edge — `./boundary.unit.test.ts`
 * still walks a page that reaches nothing Node-only.
 */
declare module "virtual:tuval/features" {
	const features: import("../features.ts").TuvalFeatures;
	export default features;
}
