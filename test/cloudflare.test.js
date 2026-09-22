import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  backupExistingConfig,
  buildConfigYaml,
  findTunnel,
  isCloudflareAddress,
  isPrivateAddress,
  isValidHostname,
  isValidTunnelName,
  judge,
  parseIngressHostnames,
} from '../src/cloudflare.js';

test('hostnames are checked before they reach cloudflared', () => {
  assert.equal(isValidHostname('movies.example.com'), true);
  assert.equal(isValidHostname('movies.nbhardwaj.ca'), true);
  assert.equal(isValidHostname('a.b.c.example.co.uk'), true);

  assert.equal(isValidHostname('movies'), false, 'a bare label is not routable');
  assert.equal(isValidHostname('https://movies.example.com'), false, 'scheme must be stripped first');
  assert.equal(isValidHostname('movies.example.com/path'), false);
  assert.equal(isValidHostname('-bad.example.com'), false);
  assert.equal(isValidHostname(''), false);
  assert.equal(isValidHostname(undefined), false);
});

test('tunnel names reject anything that would need quoting', () => {
  assert.equal(isValidTunnelName('movies'), true);
  assert.equal(isValidTunnelName('movie-night_2'), true);
  assert.equal(isValidTunnelName('-leading'), false);
  assert.equal(isValidTunnelName('has space'), false);
  assert.equal(isValidTunnelName('semi;colon'), false);
  assert.equal(isValidTunnelName(''), false);
});

test('the generated config routes only our hostname and 404s the rest', () => {
  const yaml = buildConfigYaml({
    tunnelName: 'movies',
    tunnelId: '11111111-2222-3333-4444-555555555555',
    hostname: 'movies.example.com',
    port: 8420,
  });

  assert.match(yaml, /^tunnel: movies$/m);
  assert.match(yaml, /credentials-file: .*11111111-2222-3333-4444-555555555555\.json/);
  assert.match(yaml, /- hostname: movies\.example\.com/);
  assert.match(yaml, /service: http:\/\/localhost:8420/);
  // The catch-all matters: without it any hostname pointed at the tunnel
  // would reach the app.
  assert.match(yaml, /- service: http_status:404/);
  assert.ok(yaml.indexOf('hostname: movies.example.com') < yaml.indexOf('http_status:404'));
});

test('finding a tunnel by name in cloudflared output', () => {
  const tunnels = [
    { id: 'aaa', name: 'other' },
    { id: 'bbb', name: 'movies' },
  ];
  assert.equal(findTunnel(tunnels, 'movies').id, 'bbb');
  assert.equal(findTunnel(tunnels, 'missing'), null);
  assert.equal(findTunnel([], 'movies'), null);
});

test('an existing config is backed up before being overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const target = path.join(dir, 'config.yml');

  assert.equal(backupExistingConfig(target), null, 'nothing to back up yet');

  fs.writeFileSync(target, 'tunnel: something-i-already-had\n');
  const backup = backupExistingConfig(target);
  assert.ok(backup, 'a backup path is returned');
  assert.equal(fs.readFileSync(backup, 'utf8'), 'tunnel: something-i-already-had\n');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Cloudflare proxy addresses are told apart from everything else', () => {
  // A proxied record lands in one of these; anything else means the tunnel is
  // not in the path, which is the usual reason a hostname just times out.
  assert.equal(isCloudflareAddress('104.21.14.2'), true);
  assert.equal(isCloudflareAddress('172.67.140.11'), true);
  assert.equal(isCloudflareAddress('162.159.0.1'), true);

  assert.equal(isCloudflareAddress('8.8.8.8'), false);
  assert.equal(isCloudflareAddress('203.0.113.4'), false);
  // Adjacent but outside the ranges.
  assert.equal(isCloudflareAddress('104.15.1.1'), false);
  assert.equal(isCloudflareAddress('172.72.1.1'), false);
});

test('private and carrier-grade addresses are recognised as unreachable', () => {
  assert.equal(isPrivateAddress('192.168.120.179'), true);
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('172.31.255.255'), true);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  // The VPN range a work laptop shows up on.
  assert.equal(isPrivateAddress('100.64.100.6'), true);

  assert.equal(isPrivateAddress('172.15.0.1'), false);
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  assert.equal(isPrivateAddress('104.21.14.2'), false);
  assert.equal(isPrivateAddress('100.128.0.1'), false);
});

test('the DNS verdict separates "no record" from "this machine cannot see it"', () => {
  const none = { addresses: [], error: 'ENOTFOUND' };
  const cloudflare = { addresses: ['104.21.14.2'], error: null };

  // Nobody can resolve it: the record was never made.
  assert.equal(judge({ system: none, public: none }).verdict, 'no-dns');

  // The world can, this machine cannot — a cached failure or a corporate
  // resolver, not a setup problem. Telling these apart is the whole point.
  const local = judge({ system: none, public: cloudflare });
  assert.equal(local.verdict, 'local-dns');
  assert.match(local.detail, /cached here|DNS server/);

  // Both agree and it is Cloudflare: correct.
  assert.equal(judge({ system: cloudflare, public: cloudflare }).verdict, 'ok');
});

test('the DNS verdict catches records that bypass the tunnel', () => {
  const lan = { addresses: ['192.168.120.179'], error: null };
  const elsewhere = { addresses: ['203.0.113.10'], error: null };
  const cloudflare = { addresses: ['172.67.140.11'], error: null };

  assert.equal(judge({ system: lan, public: lan }).verdict, 'private-address');
  assert.equal(judge({ system: elsewhere, public: elsewhere }).verdict, 'not-cloudflare');

  // Right addresses, but pointed at something that is not a tunnel.
  const wrong = judge({ system: cloudflare, public: cloudflare, cname: 'example.pages.dev' });
  assert.equal(wrong.verdict, 'wrong-target');

  const right = judge({
    system: cloudflare,
    public: cloudflare,
    cname: 'a86cf6b7-04a7-48e1-aaaa-bbbbbbbbbbbb.cfargotunnel.com',
  });
  assert.equal(right.verdict, 'ok');
});

test('the hostnames cloudflared is configured to serve are read back', () => {
  const yaml = buildConfigYaml({
    tunnelName: 'movies',
    tunnelId: '11111111-2222-3333-4444-555555555555',
    hostname: 'movies.nbhardwaj.ca',
    port: 8420,
  });

  // The config is the truth about what the tunnel answers for; a --hostname
  // that disagrees would print a link that cannot work.
  assert.deepEqual(parseIngressHostnames(yaml), ['movies.nbhardwaj.ca']);
  assert.ok(!parseIngressHostnames(yaml).includes('movies.nbhardwaj.cacd'));
});

test('ingress parsing copes with quotes, comments and several hostnames', () => {
  const yaml = [
    'tunnel: movies',
    'ingress:',
    '  - hostname: "one.example.com"   # first',
    '    service: http://localhost:8420',
    "  - hostname: two.example.com",
    '    service: http://localhost:9000',
    '  - service: http_status:404',
  ].join('\n');

  assert.deepEqual(parseIngressHostnames(yaml), ['one.example.com', 'two.example.com']);
  assert.deepEqual(parseIngressHostnames('tunnel: x\ningress:\n  - service: http_status:404\n'), []);
  assert.deepEqual(parseIngressHostnames(''), []);
});
