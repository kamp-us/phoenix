# @kampus/fabrika-opencode

The opencode plugin for [fabrika](../../claude-plugins/fabrika/) — fabrika's eight agent
shells and 26 skills, installed into any repo with one config line (issue #6965).

## Install

Add the package to your repo's `opencode.json`:

```json
{
	"$schema": "https://opencode.ai/config.json",
	"plugin": ["@kampus/fabrika-opencode"]
}
```

opencode installs it from npm at startup. Verify with:

```bash
opencode agent list   # the eight fabrika shells appear as subagents
opencode debug skill  # the bundled skills are listed
```

## What registers

The plugin's `config()` hook runs at startup and:

- registers each bundled agent shell as a subagent — the shell markdown under `dist/agents/`
  becomes the agent's prompt;
- appends the bundled skills dir (`dist/skills/`) to `skills.paths`, leaving paths you
  already configured in place.

Agent shells that share a name with one of your own agents resolve to the plugin's
definition; rename yours if you need both.

## Fallback: clone-and-point

Without npm, a clone of [phoenix](https://github.com/kamp-us/phoenix) works too:

```json
{
	"$schema": "https://opencode.ai/config.json",
	"skills": { "paths": ["/path/to/phoenix/claude-plugins/fabrika/skills"] }
}
```

Skills load from the clone; agents have no remote mechanism in opencode, so copy the
mirrors into your repo's `.opencode/agent/`. The tradeoff is staleness: the plugin updates
with every release cut, a clone only when you pull.

## How the bundle stays fresh

`dist/agents/` and `dist/skills/` are copied from phoenix's authored dirs at build time
(`scripts/sync-bundle.mjs`) on every publish, so a released tarball always carries the
skills dir exactly as it was authored at the tag.
