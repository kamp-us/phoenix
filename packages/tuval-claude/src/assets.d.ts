/**
 * The desk's bundler resolves a `.css` side-effect import to a module that injects the stylesheet;
 * TypeScript has no idea what a `.css` file is. Declared here rather than by pulling in
 * `vite/client`, which would add the bundler's whole ambient surface to every file in the package.
 */
declare module "*.css" {
	const url: string;
	export default url;
}
