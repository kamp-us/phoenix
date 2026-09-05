/**
 * Vite resolves a `.css` side-effect import to a module that injects the stylesheet; TypeScript has
 * no idea what a `.css` file is. Declared here rather than by pulling in `vite/client`, which would
 * also add `import.meta.env` and the rest of the bundler's ambient surface to every file in the app.
 */
declare module "*.css" {
	const url: string;
	export default url;
}
