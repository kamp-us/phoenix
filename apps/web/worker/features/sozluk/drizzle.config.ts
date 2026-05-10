import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./worker/features/sozluk/drizzle/schema.ts",
	out: "./worker/features/sozluk/drizzle/migrations",
});
