# @kampus/tuval-hsbg

Hearthstone Battlegrounds live spectator window and Jev AI strategy program for Tuval.

## Features
- **Real-Time Board Sync**: Live state streaming for Bob's tavern shop, player warband, hero stats, and combat rounds.
- **Jev AI Advisor**: Direct integration with TypeSafe Jev API (`model: jev-latest`) providing ranked turn recommendations, recruit lines, and confidence metrics.
- **Cloudflare LiveDO Room Relay**: Zero-config spectator streaming over `https://kamp.us/api/hsbg/rooms/:roomId` using dynamic room codes (e.g. `swift-wolf-42`).

## Usage

In your `.tuval/tuval.config.ts`:

```typescript
import {hsbgProgram} from "@kampus/tuval-hsbg";

export const hsbg = hsbgProgram();

export default {
  version: 1,
  programs: [hsbg],
};
```

## 3D spectator and local proof

The window embeds a Three.js board and a Blender-authored GLB table. React overlays preserve readable names, stats, connection controls, and Jev advice. Recruit shows the shop; combat shows the opponent board and marks recruit advice as the previous plan. Reduced motion and a readable WebGL fallback are supported.

Run `pnpm --filter @kampus/tuval proof:hsbg` and open http://127.0.0.1:5179/. This uses the real window view with explicitly labeled sample snapshots; it does not connect to a live bridge. Recruit, Combat, Empty, and Disconnected controls exercise the view.

`src/hsbg-state.ts` stays browser-safe. `hsbg-program.ts` retains program construction and reexports state types for compatibility. `src/board-scene.ts` owns GPU resources, projection, lighting, and cleanup; `src/board-layout.ts` maps snapshots to slots.

The table uses UV-mapped PBR materials exported from Blender as glTF, without relying on Blender-only procedural nodes. Runtime owns dynamic pieces and phase lighting. Card portraits use ordinary HTML images because the artwork CDN does not allow cross-origin WebGL texture access. Artwork is supplied by HearthstoneJSON and belongs to Blizzard; see https://hearthstonejson.com/docs/images.html. Table attribution is in `assets/README.md`.
