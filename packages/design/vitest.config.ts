import react from "@vitejs/plugin-react";
import {defineConfig} from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		name: "design",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		environment: "jsdom",
		setupFiles: ["./test-setup.ts"],
		exclude: ["node_modules/**", "dist/**", "src/a11y/**/*.test.tsx"],
	},
});
