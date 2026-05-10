import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	driver: "d1-http",
	schema: "./worker/view/drizzle/schema.ts",
	out: "./worker/view/drizzle/migrations",
});
