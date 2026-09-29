# @kampus/release-watch

Tells us when a first-party `@demlik/*` package ships a release newer than the version the
root `catalog:` in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) pins. Those pins are exact,
so they never move on their own ([#10133](https://github.com/kamp-us/phoenix/issues/10133)).

The [`release-watch`](../../.github/workflows/release-watch.yml) workflow runs it once a day
and on manual dispatch. It never opens a PR and never fails a check: a lagging pin is an issue,
not a red.

## What a run does

1. Reads every `@demlik/*` entry of the root `catalog:` block.
2. Reads each package's `latest` dist-tag from the npm registry.
3. Reads the open issues `github-actions[bot]` authored, in one REST call.
4. For each package whose `latest` is newer than its pin, files one `status:needs-triage` issue,
   or updates the one already open for it. A `latest` that equals the pin, is older, or is a
   prerelease writes nothing. So does an open issue that already says the same thing.

The open issue is found by the `<!-- release-watch pkg=<name> -->` marker in its body, never by
its title. The decision lives in [`src/release-watch.ts`](src/release-watch.ts), with no IO;
[`src/bin.ts`](src/bin.ts) does the reads and writes.

## Run it locally

```sh
GITHUB_REPOSITORY=kamp-us/phoenix GH_TOKEN="$(gh auth token)" \
  node packages/release-watch/src/bin.ts check --dry-run
```

`--dry-run` prints each package's verdict and writes nothing. `--workspace <path>` reads another
`pnpm-workspace.yaml`.
