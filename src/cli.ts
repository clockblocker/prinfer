#!/usr/bin/env bun
import { inferType } from "./index.js";

const HELP = `
prinfer - TypeScript type inference inspection tool

Usage:
  prinfer <file.ts> <name> [--project <tsconfig.json>]

Arguments:
  file.ts              Path to the TypeScript file
  name                 Name of the function/variable to inspect

Options:
  --project, -p        Path to tsconfig.json (optional)
  --help, -h           Show this help message

Examples:
  prinfer src/utils.ts myFunction
  prinfer src/utils.ts myFunction --project ./tsconfig.json
`.trim();

interface CliOptions {
  file: string;
  name: string;
  project?: string;
}

function parseArgs(argv: string[]): CliOptions | null {
  const args = argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(HELP);
    return null;
  }

  const file = args[0];
  const name = args[1];

  if (!file || !name) {
    console.error("Error: Both <file> and <name> arguments are required.\n");
    console.log(HELP);
    process.exit(1);
  }

  // Find project option
  let project: string | undefined;
  const projectIdx = args.findIndex((a) => a === "--project" || a === "-p");
  if (projectIdx >= 0) {
    project = args[projectIdx + 1];
    if (!project) {
      console.error("Error: --project requires a path argument.\n");
      console.log(HELP);
      process.exit(1);
    }
  }

  return { file, name, project };
}

function main(): void {
  const options = parseArgs(process.argv);

  if (!options) {
    process.exit(0);
  }

  try {
    const result = inferType(options.file, options.name, options.project);

    console.log(result.signature);
    if (result.returnType) {
      console.log("returns:", result.returnType);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

main();
