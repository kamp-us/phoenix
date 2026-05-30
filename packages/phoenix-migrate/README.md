# phoenix-migrate

Focused CLI for scaffolding SQL migrations for phoenix Durable Objects.

This is the first of phoenix's focused CLIs (per ADR 0035). Each focused CLI is a standalone workspace package + binary named `phoenix-<verb>`, exporting a typed Effect `Command` value from `./src/index.ts` and an executable entry at `./src/bin.ts`. A future `phoenix` dispatcher will compose them programmatically via `Command.withSubcommands`.

## Usage

From anywhere inside the workspace:

```bash
pnpm --filter @kampus-phoenix/phoenix-migrate run phoenix-migrate new <do> <name>
```

`pnpm` does not link a workspace package's own `bin` into its own `node_modules/.bin`, so the bin is exposed via a same-named `script` entry. Once another workspace package depends on `@kampus-phoenix/phoenix-migrate`, the bin will also be available as `phoenix-migrate ...` directly (via pnpm's normal bin symlinking).

### Examples

```bash
# Scaffold the next migration for the topic DO
phoenix-migrate new topic add_indexes_to_subscribers
# → apps/web/worker/features/fate-live/migrations/topic/0003_add_indexes_to_subscribers.ts
```

## Commands

### `new <do> <name>`

Scaffolds the next migration file under `apps/web/worker/features/fate-live/migrations/<do>/`.

- `<do>` — directory name of the Durable Object (e.g., `topic`).
- `<name>` — snake-case description; normalized to `[a-z0-9_]+`.

Behavior:

- Resolves the next migration ID by scanning existing files matching `^(\d+)_[^.]+\.ts$` and incrementing the max (zero-padded to 4 digits, starting at `0001`).
- Writes a stub that imports `SqlClient` and exposes a default `Effect` with a `TODO` SQL string.
- Prints the relative path of the created file to stdout.

Errors clearly if:

- The DO's migrations directory does not exist.
- The computed filename already exists.
- The normalized name is empty.

## Pointers

- Migration patterns: see the migration patterns doc and ADR 0034 (when they exist).
- CLI architecture: see ADR 0035.
