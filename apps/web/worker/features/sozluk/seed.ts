/**
 * Seed terms inserted on first init of the Sozluk DO. Empty-table check, so
 * subsequent boots are no-ops. Mirrors the dense reference's sample content
 * so a fresh deployment renders the design system with real shape rather
 * than blank lists.
 */
export type SeedDefinition = {
	authorId: string;
	authorName: string;
	body: string;
	score: number;
};

export type SeedTerm = {
	slug: string;
	title: string;
	definitions: SeedDefinition[];
};

const author = (name: string) => ({authorId: `seed_${name}`, authorName: name});

export const SEED_TERMS: SeedTerm[] = [
	{
		slug: "race-condition",
		title: "race condition",
		definitions: [
			{
				...author("merve.kaya"),
				score: 312,
				body: "İki ya da daha fazla iş parçacığının (thread, goroutine, fiber, ne dersen) paylaşılan bir kaynağa eşzamanlı erişip **doğru sıralamayı yapamaması**. Sonuç: bazen çalışır, bazen çalışmaz, bazen sadece pazartesi sabahı patlar.",
			},
			{
				...author("canyilmaz"),
				score: 187,
				body: "Türkçesi: **yarış durumu**. \"Koşulu\" değil, \"durumu\" çevirisi yerleşmiş; bir `state`'ten bahsediyoruz, `condition`'dan değil. Yine de kimse \"yarış durumu\" demiyor toplantıda.",
			},
			{
				...author("ali.tuncay"),
				score: 94,
				body: "Junior'a anlatınca: \"İki kişi aynı anda kapıdan geçmeye çalışıyor. Kapı bir kişilik. Birisi ezilir.\" Senior'a anlatınca: \"`happens-before`'u garanti eden bir şey yoksa zaten compiler ne dilerse onu yapar.\"\n\nİkisi de aynı şeyi söylüyor.",
			},
			{
				...author("kaaneren"),
				score: 61,
				body: "Go takımının ilk söylediği şey: `go run -race`. Compile-time değil, runtime detector. Production'da çalıştırmazsın çünkü 2-20x yavaşlatır; ama CI'da koşturmak ucuz bir sigorta.",
			},
		],
	},
	{
		slug: "backpressure",
		title: "backpressure",
		definitions: [
			{
				...author("eda_k"),
				score: 89,
				body: "Hızlı üreten, yavaş tüketen iki uç arasında trafiği yöneten karşı basınç mekanizması. Yoksa kuyruklar şişer, RAM dolar, sistem çöker.",
			},
		],
	},
	{
		slug: "monad",
		title: "monad",
		definitions: [
			{
				...author("arthur"),
				score: 142,
				body: "Bir endofunctor kategorisindeki monoid. Sadece `flatMap` deyin, daha kısa.",
			},
		],
	},
	{
		slug: "idempotent",
		title: "idempotent",
		definitions: [
			{
				...author("elif"),
				score: 76,
				body: "Aynı isteği iki kere göndersen de bir kere göndermişsin gibi davranan endpoint. `PUT` öyle, `POST` öyle değil — ama dünya bu kadar temiz değil.",
			},
		],
	},
	{
		slug: "eventual-consistency",
		title: "eventual consistency",
		definitions: [
			{
				...author("meriç"),
				score: 54,
				body: "\"Eninde sonunda doğru olur\" — bazen sabaha, bazen production incident'ına kadar.",
			},
		],
	},
	{
		slug: "cargo-cult",
		title: "cargo cult",
		definitions: [
			{
				...author("umutsirin"),
				score: 48,
				body: "Niye yaptığını bilmeden, başkası yapıyor diye yapılan mühendislik kararları. Microservice'leriniz neden 12 tane?",
			},
		],
	},
	{
		slug: "heisenbug",
		title: "heisenbug",
		definitions: [
			{
				...author("ali.tuncay"),
				score: 91,
				body: "Gözlemlemeye çalıştığın anda kaybolan bug. Debugger açınca ortadan yok olur, log eklediğinde de aynı şey.",
			},
		],
	},
	{
		slug: "callback-hell",
		title: "callback hell",
		definitions: [
			{
				...author("merve.kaya"),
				score: 312,
				body: "Promise'tan önceki çağ. `function(err, data) { other(data, function(err, x) { ... }) }` derinliği, indentation'ı sağ kenardan dökülür.",
			},
		],
	},
];
