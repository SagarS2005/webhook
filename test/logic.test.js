import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeToken } from '../src/rateLimiter.js';
import { assertPublicTarget, isPrivateIp } from '../src/ssrf.js';
import { validateDispatch } from '../src/validate.js';

const valid = { destinationUrl: 'https://example.com/hook', eventId: 'evt_1', payload: { event: 'user.signup' } };

test('validate: accepts a correct request', () => {
  assert.deepEqual(validateDispatch(valid), []);
});

test('validate: rejects bad input', () => {
  assert.equal(validateDispatch(undefined).length, 1);
  assert.ok(validateDispatch({ ...valid, destinationUrl: 'not a url' }).length);
  assert.ok(validateDispatch({ ...valid, destinationUrl: 'ftp://example.com' }).length);
  assert.ok(validateDispatch({ ...valid, eventId: '' }).length);
  assert.ok(validateDispatch({ ...valid, payload: 'text' }).length);
  assert.ok(validateDispatch({ ...valid, payload: [] }).length);
});

test('rate limiter: allows a burst, then makes callers wait', () => {
  const host = 'burst.example.com';
  const results = Array.from({ length: 7 }, () => takeToken(host));
  assert.deepEqual(results.slice(0, 5), [0, 0, 0, 0, 0]); // default burst = 5
  assert.ok(results[5] > 0 && results[6] > 0);
});

test('rate limiter: hosts have independent buckets', () => {
  for (let i = 0; i < 5; i++) takeToken('a.example.com');
  assert.ok(takeToken('a.example.com') > 0);
  assert.equal(takeToken('b.example.com'), 0);
});

test('ssrf: private ranges are detected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1']) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1']) assert.ok(!isPrivateIp(ip), ip);
});

test('ssrf: private targets are rejected as permanent errors', async () => {
  await assert.rejects(assertPublicTarget('http://127.0.0.1:3000/x'), (err) => err.permanent === true);
  await assert.doesNotReject(assertPublicTarget('http://8.8.8.8/x'));
});
