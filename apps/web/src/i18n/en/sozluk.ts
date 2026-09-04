import type {SozlukKey} from "../tr/sozluk";

// Lowercase like the Turkish side — the surface's voice is lowercase, and a locale swap changes
// the language, never the typographic voice. `sözlük` and `pano` are brand nouns (ADR 0347), so
// they read identically here; `brandNouns.unit.test.ts` is what holds that. `tanım` is not a brand
// noun and reads as `entry`, sözlük's own unit of writing.
export const sozluk = {
	"sozluk.entryCount.one": "{count} entry",
	"sozluk.entryCount.other": "{count} entries",
	"sozluk.voteCount.one": "{count} vote",
	"sozluk.voteCount.other": "{count} votes",

	"sozluk.alphabet.label": "Letter",
	"sozluk.alphabet.letterName": "letter {letter}",
	"sozluk.alphabet.letterEmpty": "(letter {letter}, no terms)",

	"sozluk.cta.newEntry": "new entry",
	"sozluk.createDialog.title": "New entry",
	"sozluk.createDialog.description": "type the term you want to create.",
	"sozluk.createDialog.termLabel": "Term",
	"sozluk.createDialog.termPlaceholder": "term…",
	"sozluk.createDialog.cancel": "cancel",
	"sozluk.createDialog.submit": "create",
	"sozluk.createDialog.termUnslugifiable": "A term must contain at least one letter or digit.",

	"sozluk.home.title": "sözlük",
	"sozluk.home.loading": "loading…",
	"sozluk.home.loadFailedShort": "could not load",
	"sozluk.home.loadFailed": "sözlük could not be loaded: {code}",
	"sozluk.home.recent": "recently added",
	"sozluk.home.recentWindow": "24 h",
	"sozluk.home.popular": "most upvoted",
	"sozluk.home.popularWindow": "all time",
	"sozluk.home.noTerms": "no terms yet.",
	"sozluk.home.letterEmpty": 'no term starting with "{letter}" on the first page.',
	"sozluk.home.pageEmpty": "no terms on the first page.",

	"sozluk.term.crumbRoot": "sözlük",
	"sozluk.term.firstAt": "first: {date}",
	"sozluk.term.lastEdit": "last edited: {ago}",
	"sozluk.term.loading": "loading…",
	"sozluk.term.loadFailed": "term could not be loaded: {code}",
	"sozluk.term.notFoundTitle": "term not found",
	"sozluk.term.notFoundMessage":
		'there is no term called "{slug}" yet. sign in and you can write the first entry.',
	"sozluk.term.noEntriesYet": "no entries yet",
	"sozluk.term.newTermPrompt":
		'the term "{slug}" does not exist yet. you can write the first entry.',

	"sozluk.composer.title": "how would you define it?",
	"sozluk.composer.signInPrefix": "to add an entry, ",
	"sozluk.composer.signInLink": "sign in",
	"sozluk.composer.bodyLabel": "entry",
	"sozluk.composer.bodyPlaceholder":
		"markdown supported. ```js ... ``` for a code block. a personal experience, an example, a memory; the dry sözlük definition is already on Wikipedia.",
	"sozluk.composer.hintPrefix": "markdown · ",
	"sozluk.composer.hintSubmit": "send",
	"sozluk.composer.cancel": "cancel",
	"sozluk.composer.submitting": "sending…",
	"sozluk.composer.submit": "add entry",
	"sozluk.composer.bodyRequired": "an entry cannot be empty",
	"sozluk.composer.bodyTooLong": "an entry can be at most {max} characters",
	"sozluk.composer.bodyTooLongCount": "an entry can be at most {max} characters ({length})",
	"sozluk.composer.addFailed": "could not add the entry",
	"sozluk.composer.actorFallback": "user",

	"sozluk.definition.notFound": "entry not found",
	"sozluk.definition.updateFailed": "could not update the entry",
	"sozluk.definition.deleteFailed": "could not delete the entry",
	"sozluk.definition.voteSelfDisabled": "You cannot vote on your own entry",
	"sozluk.definition.retractVote": "Retract your vote",
	"sozluk.definition.upvote": "Upvote",
	"sozluk.definition.editLabel": "edit entry",
	"sozluk.definition.cancel": "cancel",
	"sozluk.definition.saving": "saving…",
	"sozluk.definition.save": "save",
	"sozluk.definition.edit": "edit",
	"sozluk.definition.delete": "delete",
	"sozluk.definition.deleteTitle": "delete entry",
	"sozluk.definition.deleteDescription":
		"are you sure you want to delete this entry? this cannot be undone.",
	"sozluk.definition.deleteCancel": "cancel",
	"sozluk.definition.deleting": "deleting…",

	"search.title": "search",
	"search.searching": "searching…",
	"search.failed": "search failed: {code}",
	"search.minLength": "enter at least {min} letters to search.",
	"search.noResults": 'no results for "{query}".',
	"search.sozluk": "sözlük",
	"search.pano": "pano",
	"search.termCount.one": "{count} term",
	"search.termCount.other": "{count} terms",
	"search.postCount.one": "{count} post",
	"search.postCount.other": "{count} posts",
	"search.noTerms": "no terms found.",
	"search.noPosts": "no posts found.",
} satisfies Record<SozlukKey, string>;
