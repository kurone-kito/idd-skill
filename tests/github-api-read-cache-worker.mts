import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { readThroughGithubApiCache } from '../src/scripts/github-api-read-cache.mts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const role = required('IDD_CACHE_ROLE');
const directory = required('IDD_CACHE_DIR');
const workspace = required('IDD_CACHE_WORKSPACE');
const booted = required('IDD_CACHE_BOOTED');
const started = required('IDD_CACHE_STARTED');
const sleptPath = required('IDD_CACHE_SLEPT');
const releasePath = required('IDD_CACHE_RELEASE');
const countFile = required('IDD_CACHE_COUNT');

writeFileSync(booted, '1');

const result = readThroughGithubApiCache({
  classification: 'read',
  mode: 'hint',
  policy: {
    enabled: true,
    maxAgeMs: 300_000,
    maxBytes: 104857600,
    retentionMs: 86_400_000,
    directory,
  },
  host: 'github.com',
  repository: 'o/r',
  credentialMaterial: 'cred-a',
  requestShape: { path: '/repos/o/r' },
  workspaceRoot: workspace,
  cwd: workspace,
  // Only a waiting process sleeps, so this marker shows it reached the wait.
  sleep: (ms) => {
    if (!existsSync(sleptPath)) writeFileSync(sleptPath, '1');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  fetch: () => {
    const previous = existsSync(countFile)
      ? Number(readFileSync(countFile, 'utf8'))
      : 0;
    writeFileSync(countFile, String(previous + 1));
    if (role === 'leader') {
      writeFileSync(started, '1');
      const deadline = Date.now() + 10_000;
      while (!existsSync(releasePath)) {
        if (Date.now() > deadline) {
          throw new Error('leader timed out waiting for release');
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    return { status: 200, body: { source: 'leader' } };
  },
});

process.stdout.write(JSON.stringify(result));
