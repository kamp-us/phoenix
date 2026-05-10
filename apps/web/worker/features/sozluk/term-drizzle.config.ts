import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./worker/features/sozluk/term-drizzle/schema.ts",
	out: "./worker/features/sozluk/term-drizzle/migrations",
});
