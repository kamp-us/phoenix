import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./worker/features/pasaport/drizzle/schema.ts",
	out: "./worker/features/pasaport/drizzle/migrations",
});
