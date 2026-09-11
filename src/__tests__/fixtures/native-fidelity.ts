const grammaticalRelationValues = [
	"CaseCounterpart",
	"NumberCounterpart",
	"PersonCounterpart",
] as const;

type GrammaticalRelation = (typeof grammaticalRelationValues)[number];

type NoteData = {
	reading: {
		lemma: {
			ownerKind: "Lemma";
			ownerKey: string;
		};
		ownerKind: "Reading";
		ownerKey: string;
	};
};

export type ExpandedRelationClaim = Readonly<{
	relation: GrammaticalRelation;
	source: NoteData["reading"];
	target: NoteData["reading"];
}>;

export type ExpandedIndexedReading = NoteData["reading"];

// biome-ignore lint/style/useConst: `let` exposes the loose project's null widening
export let nullable = null;
