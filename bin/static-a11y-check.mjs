#!/usr/bin/env node
// The static-a11y-check command (lib/cli.mjs).

import { main } from "../lib/cli.mjs";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
