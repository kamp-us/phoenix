import {cloudflare} from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react-swc";
import {defineConfig} from "vite";

export default defineConfig({
	plugins: [react(), cloudflare()],
	server: {
		port: 3000,
		strictPort: true,
	},
	build: {
		outDir: "dist/client",
	},
});
