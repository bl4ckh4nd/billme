#!/usr/bin/env node
import { runCli } from './cli.js';

// `billme actions | head` closes the pipe early; that is the reader's choice, not a crash.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

// Not process.exit(): that would cut off output still queued on a pipe.
process.exitCode = exitCode;
