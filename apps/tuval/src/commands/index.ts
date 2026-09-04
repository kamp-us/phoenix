export {
	BadArgs,
	BadResult,
	DuplicateSpellPath,
	NoSuchWindow,
	SpellNotFound,
	UnknownSpell,
} from "./errors.ts";
export {SpellExecutor} from "./executor.ts";
export {
	buildRegistry,
	describeSource,
	describeSpell,
	type RegistryTable,
	type SpellDescription,
	type SpellNode,
	SpellRegistry,
	type SpellRow,
	type SpellSource,
} from "./registry.ts";
export {type Client, resolveScope, WindowIndex, type WindowPlacement} from "./scope.ts";
export {
	type AnySpell,
	ClientId,
	defineSpell,
	renderPath,
	type Scope,
	type Spell,
	type SpellPath,
	WindowId,
	WorkspaceId,
} from "./spell.ts";
