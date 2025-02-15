// @ts-nocheck
// eslint-disable-next-line import/order
import { test } from './prepare-test-env-ava.js';

import {
  iterateLatest,
  iterateEach,
  makeFollower,
  makeLeader,
  makeCastingSpec,
} from '../src/main.js';

import { delay } from '../src/defaults.js';
import { startFakeServer } from './fake-rpc-server.js';

// TODO: Replace with test.macro({title, exec}).
const testHappyPath = (label, ...input) => {
  // eslint-disable-next-line no-shadow
  const title = label => `happy path ${label}`;
  const makeExec =
    ({ fakeValues, iterate, start = 0, stride = 1, expectedValues, options }) =>
    async t => {
      const expected = expectedValues ?? [...fakeValues];
      t.plan(expected.length);
      const { controller, PORT } = await t.context.startFakeServer(
        t,
        fakeValues,
        options,
      );
      controller.advance(start);
      /** @type {import('../src/types.js').LeaderOptions} */
      const lo = {
        retryCallback: null, // fail fast, no retries
        keepPolling: () => delay(1000).then(() => true), // poll really quickly
        jitter: null, // no jitter
      };
      /** @type {import('../src/types.js').FollowerOptions} */
      const so = {
        proof: 'none',
      };

      // The rest of this test is taken almost verbatim from the README.md, with
      // some minor modifications (testLeaderOptions and deepEqual).
      const leader = makeLeader(`http://localhost:${PORT}/network-config`, lo);
      const castingSpec = makeCastingSpec(':mailbox.agoric1foobarbaz');
      const follower = await makeFollower(castingSpec, leader, so);
      for await (const { value } of iterate(follower)) {
        t.log(`here's a mailbox value`, value);

        // The rest here is to drive the test.
        t.deepEqual(value, expected.shift());
        if (expected.length === 0) {
          break;
        }
        controller.advance(stride);
      }
    };
  test(title(label), makeExec(...input));
};

testHappyPath('each legacy cells', {
  fakeValues: ['latest', 'later', 'done'],
  iterate: iterateEach,
  options: {},
});

testHappyPath('each stream cells batchSize=1', {
  fakeValues: ['latest', 'later', 'done'],
  iterate: iterateEach,
  options: { batchSize: 1 },
});

testHappyPath('each stream cells batchSize=2', {
  fakeValues: ['latest', 'later', 'done'],
  iterate: iterateEach,
  options: { batchSize: 2 },
});

testHappyPath('latest legacy cells', {
  fakeValues: ['latest', 'later', 'done'],
  iterate: iterateLatest,
  options: {},
});

testHappyPath('latest stream cells batchSize=1', {
  fakeValues: ['latest', 'later', 'done'],
  iterate: iterateLatest,
  options: { batchSize: 1 },
});

testHappyPath('latest stream cells batchSize=2', {
  fakeValues: ['latest', 'later', 'done'],
  expectedValues: [
    /* latest skipped because not final in batch */ 'later',
    'done',
  ],
  iterate: iterateLatest,
  options: { batchSize: 2 },
});

testHappyPath('latest stream cells batchSize=2 stride=1', {
  fakeValues: ['a1', 'a2', 'b1', 'b2', 'c'],
  expectedValues: ['a2', 'b1', 'b2', 'c'],
  iterate: iterateLatest,
  options: { batchSize: 2 },
});

testHappyPath('latest stream cells batchSize=2 stride=2', {
  fakeValues: ['a1', 'a2', 'b1', 'b2', 'c'],
  expectedValues: ['a2', 'b2', 'c'],
  iterate: iterateLatest,
  stride: 2,
  options: { batchSize: 2 },
});

testHappyPath('latest legacy cells, start at 1', {
  fakeValues: ['latest', 'later', 'done'],
  expectedValues: ['later', 'done'],
  iterate: iterateLatest,
  start: 1,
  options: {},
});

testHappyPath('latest legacy cells, stride by 2', {
  fakeValues: ['latest', 'later', 'done'],
  expectedValues: ['latest', /* skip later */ 'done'],
  iterate: iterateLatest,
  stride: 2,
  options: {},
});

test('bad network config', async t => {
  const { PORT } = await t.context.startFakeServer(t, []);
  await t.throwsAsync(
    () =>
      makeLeader(`http://localhost:${PORT}/bad-network-config`, {
        retryCallback: null,
        jitter: null,
      }),
    {
      message: /rpcAddrs .* must be an array/,
    },
  );
});

test('missing rpc server', async t => {
  const { PORT } = await t.context.startFakeServer(t, []);
  await t.throwsAsync(
    () =>
      makeLeader(`http://localhost:${PORT}/missing-network-config`, {
        retryCallback: null,
        jitter: null,
      }),
    {
      message: /^invalid json response body/,
    },
  );
});

test('unrecognized proof', async t => {
  await t.throwsAsync(
    () =>
      makeFollower(makeCastingSpec(':activityhash'), {}, { proof: 'bother' }),
    {
      message: /unrecognized follower proof mode.*/,
    },
  );
});

test.before(t => {
  t.context.cleanups = [];
  t.context.startFakeServer = startFakeServer;
});

test.after(t => {
  t.context.cleanups.map(cleanup => cleanup());
});
