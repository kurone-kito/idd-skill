import { ghText } from '../src/scripts/gh-exec.mts';
import { findLoadControlRefusal } from '../src/scripts/github-api-refusal.mts';

// Subprocess fixture for gh-exec-load-control.test.mts: one gh call through
// the real wrapper, configured only by this working directory's own
// .github/idd/config.json and the environment. It prints one JSON line.

try {
  const output =
    process.env.IDD_WORKER_CALL === 'write'
      ? ghText(
          [
            'api',
            '--method',
            'POST',
            'repos/o/r/issues/1/comments',
            '--input',
            '-',
          ],
          { input: '{}' },
        )
      : ghText(['api', 'repos/o/r']);
  process.stdout.write(`${JSON.stringify({ ok: true, output })}\n`);
} catch (error) {
  const detail = findLoadControlRefusal(error);
  process.stdout.write(
    `${JSON.stringify(detail ? { refused: true, detail } : { refused: false, failed: true })}\n`,
  );
}
