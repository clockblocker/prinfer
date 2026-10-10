import type { HoverCost } from "../types.js";
import { getHoverInfo } from "./hover.js";
import { ts } from "./ts-runtime.js";

/**
 * Count the checker work behind a hover; see `HoverCost`. The work is
 * repeated on a new program over the loaded program's source files, whose
 * checker starts empty, so no earlier lookup has done any of it. The files
 * are not read, parsed, or bound again. What is counted is resolving the
 * node's type and writing its untruncated text: the same work whatever the
 * display options of the hover it accompanies.
 */
export function measureHoverCost(
	program: ts.Program,
	node: ts.Node,
	sourceFile: ts.SourceFile,
): HoverCost {
	const fresh = programWithFreshChecker(program);
	if (fresh.getSourceFile(sourceFile.fileName) !== sourceFile) {
		throw new Error(
			`Could not reuse ${sourceFile.fileName} in a new program to count type instantiations`,
		);
	}
	// Creating the checker merges every file's globals; that setup costs
	// the same for any lookup and is left out.
	const instantiations = fresh.getInstantiationCount();
	const types = fresh.getTypeCount();
	getHoverInfo(fresh, node, sourceFile, false, true);
	return {
		instantiations: fresh.getInstantiationCount() - instantiations,
		types: fresh.getTypeCount() - types,
	};
}

/** The same program with a checker of its own, sharing its source files. */
function programWithFreshChecker(program: ts.Program): ts.Program {
	const options = program.getCompilerOptions();
	const host = ts.createCompilerHost(options);
	const readSourceFile = host.getSourceFile;
	host.getSourceFile = (fileName, ...rest) =>
		program.getSourceFile(fileName) ?? readSourceFile(fileName, ...rest);
	return ts.createProgram({
		rootNames: program.getRootFileNames(),
		options,
		host,
		oldProgram: program,
		projectReferences: program.getProjectReferences(),
	});
}
