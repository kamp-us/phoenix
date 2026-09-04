export {
	type Binding,
	BindingError,
	type BindingSource,
	type CompiledBindings,
	type ConfigFile,
	type ConfigLayer,
	compileBindings,
	describeFile,
	KeyBindingInput,
	KeyBindings,
	renderBindingErrors,
} from "./bindings/index.ts";
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
	buildSpellIndex,
	type Candidate,
	type CandidateKind,
	complete,
	describeExpected,
	didYouMean,
	type IndexedSpell,
	type IndexNode,
	type ParamSpec,
	type ParseResult,
	parse,
	readParams,
	type SpellCallDraft,
	type SpellIndex,
	type Token,
	type Tokenization,
	tokenize,
} from "./parse/index.ts";
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
