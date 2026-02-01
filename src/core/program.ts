import path from "node:path";
import ts from "typescript";

/**
 * Find the nearest tsconfig.json from a starting directory
 */
export function findNearestTsconfig(startDir: string): string | undefined {
	return (
		ts.findConfigFile(startDir, ts.sys.fileExists, "tsconfig.json") ??
		undefined
	);
}

/**
 * Load a TypeScript program from an entry file
 */
export function loadProgram(
	entryFileAbs: string,
	project?: string,
): ts.Program {
	const fileDir = path.dirname(entryFileAbs);
	const tsconfigPath = project
		? path.resolve(process.cwd(), project)
		: findNearestTsconfig(fileDir);

	if (!tsconfigPath) {
		// Fallback: single-file program
		return ts.createProgram([entryFileAbs], {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			strict: true,
			allowJs: true,
			checkJs: false,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			skipLibCheck: true,
		});
	}

	const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (cfg.error) {
		throw new Error(
			ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"),
		);
	}

	const parsed = ts.parseJsonConfigFileContent(
		cfg.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);
	return ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
	});
}
