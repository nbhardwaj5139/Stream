import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { summariseTunnelError, superviseTunnel } from '../src/tunnel.js';

// A tunnel whose process can be made to exit on demand.
function fakeTunnel(name) {
  const process = new EventEmitter();
  return { name, process, stopped: false, stop() { this.stopped = true; process.emit('close', null); } };
}

// Waits for nothing, but lets the supervisor's loop take its next step.
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('no internet at start-up is waited out, not given up on', async () => {
  // Windows logs in before the Wi-Fi is up. The first attempts fail; it must
  // keep trying, and say so, until one works.
  let attempts = 0;
  const waited = [];
  const supervisor = superviseTunnel({
    start: async () => {
      attempts += 1;
      if (attempts < 4) throw new Error('dial tcp: lookup region1.v2.argotunnel.com: no such host');
      return fakeTunnel('up');
    },
    onWaiting: (error, delay) => waited.push(delay),
    wait: async () => {},
  });

  const tunnel = await supervisor.ready;
  assert.equal(tunnel.name, 'up');
  assert.equal(attempts, 4);
  assert.deepEqual(waited, [2000, 5000, 10_000], 'backing off, not hammering');
  supervisor.stop();
});

test('a tunnel that drops mid-evening is started again by itself', async () => {
  const started = [];
  const events = [];
  const supervisor = superviseTunnel({
    start: async () => {
      const tunnel = fakeTunnel(`tunnel-${started.length + 1}`);
      started.push(tunnel);
      return tunnel;
    },
    onUp: (tunnel) => events.push(`up:${tunnel.name}`),
    onDown: (code) => events.push(`down:${code}`),
    wait: async () => {},
  });

  await supervisor.ready;
  // The laptop slept, or the network changed: cloudflared exits.
  started[0].process.emit('close', 1);
  for (let i = 0; i < 5; i += 1) await tick();

  assert.deepEqual(events, ['up:tunnel-1', 'down:1', 'up:tunnel-2']);
  assert.equal(supervisor.current, started[1]);
  supervisor.stop();
});

test('the waiting never runs out', async () => {
  // Not "eight tries and then give up": the laptop may be offline for hours.
  let attempts = 0;
  const waited = [];
  const supervisor = superviseTunnel({
    start: async () => {
      attempts += 1;
      if (attempts < 50) throw new Error('offline');
      return fakeTunnel('finally');
    },
    onWaiting: (error, delay) => waited.push(delay),
    wait: async () => {},
  });

  assert.equal((await supervisor.ready).name, 'finally');
  assert.equal(waited.length, 49);
  assert.equal(Math.max(...waited), 30_000, 'the gap stops growing at half a minute');
  supervisor.stop();
});

test('stopping the room stops the tunnel and every retry', async () => {
  let attempts = 0;
  const supervisor = superviseTunnel({
    start: async () => {
      attempts += 1;
      throw new Error('offline');
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 5)),
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  supervisor.stop();
  const after = attempts;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(attempts, after, 'no attempts after stopping');
});

test('a stopped room does not restart a tunnel that exits as it shuts down', async () => {
  const started = [];
  const supervisor = superviseTunnel({
    start: async () => {
      const tunnel = fakeTunnel('only');
      started.push(tunnel);
      return tunnel;
    },
    wait: async () => {},
  });

  const tunnel = await supervisor.ready;
  supervisor.stop();
  for (let i = 0; i < 5; i += 1) await tick();

  assert.equal(tunnel.stopped, true);
  assert.equal(started.length, 1, 'not brought back up');
});

test('a page of cloudflared log comes down to its one useful line', () => {
  const log = [
    '2026-09-24T10:00:01Z INF Starting tunnel tunnelID=abc',
    '2026-09-24T10:00:02Z INF Version 2026.9.0',
    '2026-09-24T10:00:03Z ERR Failed to dial a quic connection error="timeout: no recent network activity"',
    '2026-09-24T10:00:04Z INF Retrying connection in up to 2s',
  ].join('\n');

  // The ERR line, without its timestamp — not the first line, not the log.
  assert.equal(
    summariseTunnelError(new Error(`cloudflared did not connect within 45s\n${log}`)),
    'Failed to dial a quic connection error="timeout: no recent network activity"'
  );
  assert.equal(summariseTunnelError(new Error('spawn cloudflared ENOENT')), 'spawn cloudflared ENOENT');
  assert.equal(summariseTunnelError(''), 'no reason given');
  assert.ok(summariseTunnelError(new Error('x'.repeat(500))).length <= 160);
});
