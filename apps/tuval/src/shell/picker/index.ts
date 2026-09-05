/**
 * The program picker: what an empty window shows, and the one handler both routes into it end in.
 * The handler is the kernel's; a browser module imports `./browser.ts` instead.
 */

export * from "./browser.ts";
export {type PickerOptions, runPickerIntent} from "./open.ts";
