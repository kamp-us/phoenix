import react from "@vitejs/plugin-react";
import {defineConfig} from "vitest/config";

// The pack project runs under plain node: `test-setup.ts` patches DOM globals that only jsdom has.
export default defineConfig({
	plugins: [react()],
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "design",
					include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
					environment: "jsdom",
					setupFiles: ["./test-setup.ts"],
					exclude: [
						"node_modules/**",
						"dist/**",
						"src/a11y/**/*.test.tsx",
						"src/**/*.pack.test.ts",
					],
				},
			},
			{
				test: {
					name: "pack",
					include: ["src/**/*.pack.test.ts"],
					pool: "forks",
				},
			},
		],
	},
});
