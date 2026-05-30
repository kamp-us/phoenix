import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";

export class WorkspaceRootNotFound extends Data.TaggedError(
	"phoenix-migrate/WorkspaceRootNotFound",
)<{readonly cwd: string}> {}

export class MigrationsDirMissing extends Data.TaggedError("phoenix-migrate/MigrationsDirMissing")<{
	readonly durableObject: string;
	readonly path: string;
}> {}

export class MigrationAlreadyExists extends Data.TaggedError(
	"phoenix-migrate/MigrationAlreadyExists",
)<{readonly path: string}> {}

export class MigrationNameEmpty extends Data.TaggedError("phoenix-migrate/MigrationNameEmpty")<{
	readonly raw: string;
}> {}

const TEMPLATE = `import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
\tsql\`-- TODO: write your DDL/DML here\`
);
`;

const MIGRATION_FILE_PATTERN = /^(\d+)_[^.]+\.ts$/;

const normalizeName = (raw: string): string =>
	raw
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

/**
 * Find the workspace root by walking up from cwd looking for `pnpm-workspace.yaml`.
 */
const findWorkspaceRoot = Effect.fn("findWorkspaceRoot")(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const cwd = process.cwd();
	let current = cwd;
	// Hard cap on traversal to avoid infinite loops.
	for (let i = 0; i < 32; i++) {
		const marker = path.join(current, "pnpm-workspace.yaml");
		const exists = yield* fs.exists(marker);
		if (exists) return current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return yield* new WorkspaceRootNotFound({cwd});
});

export const newCommand = Command.make(
	"new",
	{
		durableObject: Argument.string("do"),
		name: Argument.string("name"),
	},
	({durableObject, name}) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const workspaceRoot = yield* findWorkspaceRoot();
			const migrationsRoot = path.join(
				workspaceRoot,
				"apps",
				"web",
				"worker",
				"infra",
				"migrations",
			);
			const targetDir = path.join(migrationsRoot, durableObject);

			const dirExists = yield* fs.exists(targetDir);
			if (!dirExists) {
				return yield* new MigrationsDirMissing({
					durableObject,
					path: path.relative(workspaceRoot, targetDir),
				});
			}

			const entries = yield* fs.readDirectory(targetDir);
			const ids = entries
				.map((entry) => MIGRATION_FILE_PATTERN.exec(entry))
				.filter((match): match is RegExpExecArray => match !== null)
				.map((match) => Number.parseInt(match[1]!, 10))
				.filter((n) => Number.isFinite(n));

			const nextId = (ids.length === 0 ? 1 : Math.max(...ids) + 1).toString().padStart(4, "0");

			const normalized = normalizeName(name);
			if (normalized.length === 0) {
				return yield* new MigrationNameEmpty({raw: name});
			}

			const filename = `${nextId}_${normalized}.ts`;
			const fullPath = path.join(targetDir, filename);

			const fileExists = yield* fs.exists(fullPath);
			if (fileExists) {
				return yield* new MigrationAlreadyExists({
					path: path.relative(workspaceRoot, fullPath),
				});
			}

			yield* fs.writeFileString(fullPath, TEMPLATE);
			yield* Console.log(path.relative(workspaceRoot, fullPath));
		}),
).pipe(Command.withDescription("Scaffold the next SQL migration file for a Durable Object."));
