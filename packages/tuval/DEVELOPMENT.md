# Develop Tuval

## Build and launch locally

1. Build the package:

   ```bash
   pnpm --filter tuval build
   ```

2. Launch the declared executable:

   ```bash
   node packages/tuval/dist/backend/bin.js
   ```

The process prints its selected URL after the server is ready and opens it in the default browser.

## Launch with live pi sessions

The default command runs Tuval's in-process production coding-agent protocol service. It reads pi's
ordinary settings, packages, credentials, and session files from `PI_CODING_AGENT_DIR` (or the
standard pi agent directory when the variable is absent):

```bash
node packages/tuval/dist/backend/bin.js
```

To use a separately managed Pi protocol service instead, pass its explicit Unix socket. The override
stays local to the filesystem; it never opens a network listener:

```bash
node packages/tuval/dist/backend/bin.js --pi-socket /tmp/pi.sock
```

## Launch headless on a fixed port

1. Build the package:

   ```bash
   pnpm --filter tuval build
   ```

2. Launch without opening a browser:

   ```bash
   node packages/tuval/dist/backend/bin.js --port 4310 --no-open
   ```

## Run the checks

```bash
pnpm --filter tuval typecheck
pnpm --filter tuval test:unit
pnpm --filter tuval test:browser
```
