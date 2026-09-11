type ReadingRenderContext<
	Language extends string,
	Entity extends string,
	PartOfSpeech extends string,
> = {
	readonly language: Language;
	readonly entity: Entity;
	readonly partOfSpeech: PartOfSpeech;
	readonly field01: Language;
	readonly field02: Entity;
	readonly field03: PartOfSpeech;
	readonly field04: Language;
	readonly field05: Entity;
	readonly field06: PartOfSpeech;
	readonly field07: Language;
	readonly field08: Entity;
	readonly field09: PartOfSpeech;
	readonly field10: Language;
	readonly field11: Entity;
	readonly field12: PartOfSpeech;
	readonly finalField: Language;
};

// biome-ignore lint/correctness/noUnusedVariables: looked up by name from this fixture
type test = ReadingRenderContext<"de", "Lexeme", "VERB">;
