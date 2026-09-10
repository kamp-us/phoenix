/**
 * The process board as the page mounts it. Importing this pulls React, `@kampus/design` and the
 * board's own stylesheet — and nothing from `../../ai-agent/`, which is the board's whole point.
 */

export {ProcessBoard, type ProcessBoardProps} from "./ProcessBoard.tsx";
export {enteredSince, type Tile, tileIds, tilesOf} from "./tiles.ts";
