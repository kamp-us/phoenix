/**
 * The one leaf both the transcript and the command vocabulary need: a tool call's input, a tool
 * result's details, a protocol error's details. It has its own file because putting it in either of
 * those would make the two import each other.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
