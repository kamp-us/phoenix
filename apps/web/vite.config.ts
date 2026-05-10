import {cloudflare} from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react-swc";
import {defineConfig} from "vite";

export default defineConfig({
	plugins: [
		react({
			plugins: [
				[
					"@swc/plugin-relay",
					{
						rootDir: __dirname,
						artifactDirectory: "./src/__generated__",
						language: "typescript",
						eagerEsModules: true,
					},
				],
			],
		}),
		cloudflare(),
	],
	server: {
		port: 3000,
		strictPort: true,
	},
	build: {
		outDir: "dist/client",
	},
});
