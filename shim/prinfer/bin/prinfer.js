#!/usr/bin/env node
import { forward } from "./forward.js";

// `prinfer mcp` speaks MCP over stdio and stays quiet; every other command
// gets one line on stderr, so --json output on stdout is unchanged.
if (process.argv[2] !== "mcp") {
	process.stderr.write(
		"prinfer is now typeprobe: use `npx typeprobe` (npm i -D typeprobe) instead. See https://github.com/clockblocker/typeprobe#migrating-from-prinfer\n",
	);
}

await forward("cli.js");
