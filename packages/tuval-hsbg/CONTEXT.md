# Hearthstone Battlegrounds Jev AI & Tuval Spectator System

## 1. Executive Overview
This system is an end-to-end distributed AI assistant and live spectator suite for **Hearthstone Battlegrounds**:
1. **Game Engine & Tracker (`tools/hsbg-jev`)**: Real-time Hearthstone log parser (`Power.log`, `Bob.log`), entity tracker, state machine, and overlay with TypeSafe Jev API (`model: jev-latest`) evaluation.
2. **Cloudflare LiveDO Room Relay (`apps/web/worker/features/hsbg`)**: Zero-config room-based relay (`https://kamp.us/api/hsbg/rooms/:roomId`) powered by Cloudflare Durable Objects.
3. **Tuval Extension Program (`packages/tuval-hsbg`)**: Official `@kampus/tuval-hsbg` package running on Demlik TEA architecture, rendering live player boards, Bob's shop, enemy warbands, and real-time AI turn recommendations.
4. **1-Click macOS App (`JevBGAdvisor.app`)**: Standalone deliverable bundle for players with automated `log.config` generation, virtual environment setup, and GUI room code generator.

---

## 2. Architecture & Data Flow

```
┌────────────────────────────────────────────────────────┐
│ Hearthstone Client (Player's Mac / Windows)            │
│ Writes real-time game logs to Power.log & Zone.log     │
└──────────────────────────┬─────────────────────────────┘
                           │ (tail -F log files)
                           ▼
┌────────────────────────────────────────────────────────┐
│ Local Engine: JevBGAdvisor / setup_wizard.py           │
│ - log_parser.py: Extract entity tags, zones, heroes    │
│ - phase_aware_tracker.py: Deduce recruit vs combat     │
│ - engine.py: Query TypeSafe Jev API (jev-latest)       │
│ - native_overlay.py: Transparent PyQt6 desktop HUD     │
│ - live_bridge.py: HTTP server & Cloudflare publisher   │
└──────────────────────────┬─────────────────────────────┘
                           │ POST /api/hsbg/rooms/:roomId
                           ▼
┌────────────────────────────────────────────────────────┐
│ Cloudflare Worker & LiveDO Relay (apps/web)            │
│ Route: apps/web/worker/features/hsbg/route.ts          │
│ LiveDO Topic: hsbg:<roomId> (e.g. swift-wolf-42)       │
└──────────────────────────┬─────────────────────────────┘
                           │ GET /api/hsbg/rooms/:roomId
                           ▼
┌────────────────────────────────────────────────────────┐
│ Tuval Spectator: @kampus/tuval-hsbg (Phoenix Monorepo) │
│ - hsbg-program.ts: Demlik TEA State Machine            │
│ - window.tsx: Spectator HUD & 3D Three.js scene        │
└────────────────────────────────────────────────────────┘
```

---

## 3. Repositories & Key Directories

### A. Monorepo (`cansirin/monorepo`)
- **Path**: `csirin/monorepo: tools/hsbg-jev`
- **Core Components**:
  - `setup_wizard.py`: GUI launcher with room generator (`🎲 New` button) and 1-click start.
  - `live_bridge.py`: Local HTTP server (`:7860`) + auto-publisher to Cloudflare LiveDO rooms.
  - `engine.py` & `phase_aware_tracker.py`: State reconstructor and Jev API query client.
  - `native_overlay.py`: Native floating HUD overlay for in-game recommendations.
  - `build_app.sh`: Script to compile `JevBGAdvisor.app` and output `JevBGAdvisor.zip` to Desktop.

### B. Phoenix Monorepo (`kamp-us/phoenix`)
- **Package Path**: `packages/tuval-hsbg`
  - `package.json`: `@kampus/tuval-hsbg` package definition.
  - `src/hsbg-program.ts`: Authored program using `@kampus/tuval/authoring` and `@demlik/tea`.
  - `src/renderer-ref.ts`: Module renderer specifier (`@kampus/tuval-hsbg/window`).
  - `src/window.tsx`: React spectator window component and default window renderer.
- **Tuval App**: `apps/tuval`
  - `apps/tuval/package.json`: Contains `"@kampus/tuval-hsbg": "workspace:*"`.
  - `apps/tuval/src/page/renderers.tsx`: Imports HSBG window for Tuval desk.
- **Cloudflare Worker**: `apps/web/worker`
  - `apps/web/worker/features/hsbg/route.ts`: LiveDO room HTTP publish and snapshot routes.
  - `apps/web/worker/http/worker-routes.ts`: Registered under `/api/hsbg/rooms/*`.

---

## 4. How to Run & Verify

### 1. Player Side (Local / Standalone)
- Run `JevBGAdvisor.app` or `python setup_wizard.py`.
- Pick/reroll a room name (e.g. `swift-wolf-42`).
- Click **"Launch Live Advisor + Stream Bridge"**.

### 2. Spectator Side (Tuval)
- In `~/.tuval/tuval.config.ts`:
  ```typescript
  import {hsbgProgram} from "@kampus/tuval-hsbg";
  export const hsbg = hsbgProgram();
  export default { programs: [hsbg] };
  ```
- Launch Tuval (`pnpm --filter @kampus/tuval dev`).
- In the Spectator Stream input box, type the room code (e.g. `swift-wolf-42` or `http://localhost:7860`).
- Live board state, shop, player warband, and Jev AI recruit lines will synchronize automatically.

---

## 5. Upcoming Work (Next Agent Roadmap)
- **3D Warcraft III / Hearthstone Tavern UI (`packages/tuval-hsbg/src/window.tsx`)**:
  - Replace flat 2D HTML boxes with a Three.js WebGL scene.
  - Carve stone frames, tavern table, and 3D card pedestals via Blender MCP.
  - Add dynamic torch/campfire lighting and smooth combat camera transitions.
