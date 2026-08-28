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
pnpm --filter tuval test
```
