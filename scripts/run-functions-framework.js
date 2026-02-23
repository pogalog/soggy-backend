"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function parseArgs(argv) {
  const args = [];
  let mode = "production";

  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length) || mode;
      continue;
    }
    args.push(arg);
  }

  return { mode, passthroughArgs: args };
}

function main() {
  const { mode, passthroughArgs } = parseArgs(process.argv.slice(2));
  const env = { ...process.env, NODE_ENV: mode };

  const binName = process.platform === "win32"
    ? "functions-framework.cmd"
    : "functions-framework";
  const localBin = path.join(process.cwd(), "node_modules", ".bin", binName);

  if (!fs.existsSync(localBin)) {
    console.error(
      "Unable to find local Functions Framework binary at node_modules/.bin/functions-framework. Run `npm install` first."
    );
    process.exit(1);
  }

  const child = spawn(
    localBin,
    ["--target=api", "--signature-type=http", ...passthroughArgs],
    {
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true
    }
  );

  child.on("error", (error) => {
    console.error("Failed to start Functions Framework", { message: error.message });
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main();
