import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';

// listOpenWorkItems (Copilot review, #2400): provider-port.mts's doc comment
// on this method pins its state field to REST's raw lowercase form
// ('open'/'closed'), deliberately unlike getWorkItem's uppercased 'OPEN' --
// the fake adapter's implementation filtered on the wrong casing, so any
// fixture written per the documented contract ('open') silently returned no
// items instead of the caller's expected match.
test("listOpenWorkItems filters on the port's documented lowercase 'open' state", () => {
  const port = createFakeProviderAdapter({
    workItems: {
      1: { number: 1, title: 'open issue', body: '', state: 'open' },
      2: { number: 2, title: 'closed issue', body: '', state: 'closed' },
    },
  });
  const result = port.listOpenWorkItems();
  assert.deepEqual(
    result.map((item) => item.number),
    [1],
  );
});

test('listOpenWorkItems does not match an uppercase OPEN fixture (regression guard)', () => {
  const port = createFakeProviderAdapter({
    workItems: {
      1: { number: 1, title: 'wrong casing', body: '', state: 'OPEN' },
    },
  });
  assert.deepEqual(port.listOpenWorkItems(), []);
});
