#!/usr/bin/env node
// The typeprobe MCP server under its old command name. Nothing is printed:
// stdout carries the MCP protocol. Its serverInfo already says typeprobe.
import { forward } from "./forward.js";

await forward("mcp.js");
