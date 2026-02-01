// Test fixture for generic method call type inference

type CommandKind = "Generate" | "Lemma";

type InputByKind = {
	Generate: { attestation: string };
	Lemma: { lemma: string };
};

type CommandInput<K extends CommandKind> = { kind: K } & InputByKind[K];

export class Commander {
	executeCommand<K extends CommandKind>(
		name: K,
		_input: CommandInput<K>,
	): { result: K } {
		return { result: name };
	}

	run() {
		const input = { kind: "Generate" as const, attestation: "test" };
		return this.executeCommand("Generate", input);
	}
}
