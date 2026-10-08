'use strict';

// Behind the `gh` launcher that tests/isolate-gh.mts writes into the guard
// root's `bin` directory and puts first on PATH. A shell that resolves `gh`
// through PATH reaches this script, which only records the attempt and
// refuses it. It never starts a real gh, so no launch can reach the CLI here.

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');

function containsCredential(value) {
  return /(?:gh(?:p|o|u|s|r)_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|github_pat|\bBearer\s+\S+|\b[A-Za-z_][A-Za-z0-9_]*(?:token|password|secret|authorization|key)=\S+)/iu.test(
    value,
  );
}

// A copy of `safeArguments` in tests/isolate-gh.mts, kept in step with it by
// hand: the same redaction rules, so a shim-launched attempt is stored the
// same way as an in-process one.
function safeArguments(args) {
  const safe = [];
  let redactNext = false;
  for (const value of args) {
    const argument = String(value);
    if (redactNext) {
      safe.push('[redacted]');
      redactNext = false;
      continue;
    }
    const environmentAssignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(
      argument,
    );
    if (environmentAssignment) {
      safe.push(`${environmentAssignment[1]}=[redacted]`);
      continue;
    }
    const optionAndValue = /^(--?[A-Za-z0-9-]+)=(.*)$/u.exec(argument);
    if (optionAndValue) {
      const [, option, optionValue] = optionAndValue;
      const sensitiveOption =
        /^--?(?:token|password|secret|authorization|auth-token|access-token|client-secret)$/iu.test(
          option ?? '',
        );
      safe.push(
        `${option}=${sensitiveOption || containsCredential(optionValue ?? '') ? '[redacted]' : '[value]'}`,
      );
      continue;
    }
    if (
      /^--?(?:body|body-file|field|raw-field|header|input|json|title|token|password|secret|authorization|config|hostname)$/iu.test(
        argument,
      ) ||
      /^-[fFH]$/u.test(argument)
    ) {
      safe.push(argument);
      redactNext = true;
      continue;
    }
    safe.push(containsCredential(argument) ? '[redacted]' : argument);
  }
  return safe;
}

const ledger = process.env.IDD_TEST_GH_GUARD_LEDGER;
if (ledger) {
  const attempt = {
    id: randomUUID(),
    at: new Date().toISOString(),
    api: 'path-shim',
    executable: 'gh',
    resolvedExecutable: null,
    args: safeArguments(process.argv.slice(2)),
    pid: process.pid,
    threadId: 0,
  };
  fs.appendFileSync(ledger, `${JSON.stringify(attempt)}\n`, 'utf8');
}
process.stderr.write(
  'IDD_UNEXPECTED_REAL_GH: a gh launch reached the test guard PATH shim; no real gh was started.\n',
);
process.exitCode = 1;
