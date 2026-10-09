import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebsiteSubmission } from '../src/intake.ts';

test('Given bounded legacy form fields, when parsed, then preserves supplied values', () => {
  const value = parseWebsiteSubmission({
    message: 'Senior engineer opening', contact: 'user@example.test',
    company: 'Example GmbH', role: 'Senior Engineer', jobUrl: 'https://jobs.example.test/123',
    humanCheckToken: 'token', humanCheckAnswer: '9',
  });
  assert.equal(value.company, 'Example GmbH');
  assert.equal(value.role, 'Senior Engineer');
});

test('Given oversized form content, when parsed, then rejects it', () => {
  assert.throws(() => parseWebsiteSubmission({ message: 'x'.repeat(8001) }), /message/i);
});

test('Given a chat-only website intake, when jobUrl is omitted, then it remains valid', () => {
  const value = parseWebsiteSubmission({ message: 'I spoke with Acme about a backend role', contact: 'user@example.test', company: 'Acme', role: 'Backend Engineer' });
  assert.equal(value.jobUrl, undefined);
});

test('Given a valid challenge, when verified for its integration, then returns a nonce for durable single-use tracking', async () => {
  const { issueHumanChallenge, verifyHumanChallenge } = await import('../src/intake.ts');
  const secret = '01234567890123456789012345678901';
  const challenge = await issueHumanChallenge(secret, 'integration-a');
  const match = challenge.prompt.match(/(\d+) \+ (\d+)/);
  assert.ok(match);
  const result = await verifyHumanChallenge(secret, 'integration-a', challenge.token, String(Number(match[1]) + Number(match[2])));
  assert.ok(result.nonce.length >= 16);
  await assert.rejects(verifyHumanChallenge(secret, 'integration-b', challenge.token, String(Number(match[1]) + Number(match[2]))));
});
