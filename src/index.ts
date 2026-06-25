#!/usr/bin/env node
import { spawn } from "child_process";
import { startServer, runLibMode } from "./server/index.js";
import { startVisualizeServer } from "./server/visualize.js";
import { VERSION } from "./version.js";

const args = process.argv.slice(2);
const hasHelp = args.includes("--help") || args.includes("-h") || args.includes("help");
const hasVersion = args.includes("--version") || args.includes("-V");
const hasLib = args.includes("-lib") || args.includes("--library");
const hasVisualizer = args.includes("-vis") || args.includes("--visualize");

function printHelp(): void {
  console.log(`Lemma ${VERSION}

Usage:
  lemma                 Start the MCP server over stdio
  lemma -lib            Print a full knowledge-base snapshot
  lemma -vis            Start the visualizer in the background
  lemma -vis --fg       Start the visualizer in the foreground
  lemma -vis -p 8080    Start the visualizer on a custom port
  lemma --version       Print the version
  lemma --help          Show this help
`);
}

function parsePortArg(): number | undefined {
  const portIdx = args.includes("-p") ? args.indexOf("-p") : args.indexOf("--port");
  if (portIdx === -1) return undefined;

  const raw = args[portIdx + 1];
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${raw ?? "(missing)"}. Use a number from 1 to 65535.`);
  }
  return port;
}

async function main(): Promise<void> {
  if (hasHelp) {
    printHelp();
    process.exit(0);
  } else if (hasVersion) {
    console.log(VERSION);
    process.exit(0);
  } else if (hasLib) {
    await runLibMode();
  } else if (hasVisualizer) {
    const port = parsePortArg();

    if (!args.includes("--fg")) {
      const serverArgs = [process.argv[1], "-vis", "--fg"];
      if (port) { serverArgs.push("-p", String(port)); }

      const child = spawn(process.execPath, serverArgs, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      console.error(``);
      console.error(`  Lemma Visualizer started in background (PID ${child.pid})`);
      console.error(`  http://localhost:${port || 3456}`);
      console.error(`  Stop: kill ${child.pid}`);
      console.error(``);
      process.exit(0);
    } else {
      await startVisualizeServer(port);
    }
  } else if (args.length === 0) {
    await startServer();
  } else {
    console.error(`Unknown argument(s): ${args.join(" ")}`);
    console.error(`Run "lemma --help" for usage.`);
    process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
}
