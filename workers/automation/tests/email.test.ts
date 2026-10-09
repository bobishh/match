import assert from 'node:assert/strict';
import test from 'node:test';
import { correlateApplication, parseForwardedMail } from '../src/email.ts';

test('Given a unique exact thread reference, when correlated, then selects the existing application', () => {
  const result = correlateApplication({
    messageId: '<new@example.test>', inReplyTo: '<application@example.test>', references: [],
    from: 'recruiter@example.test', to: 'intake@example.test', subject: 'Interview', text: '', date: null, urls: [], confirmation: false,
  }, [{ cardId: 'card-1', messageIds: ['<application@example.test>'] }]);
  assert.equal(result.kind, 'matched');
});

test('Given two roles at one company and no role clue, when correlated, then requires review', () => {
  const result = correlateApplication({
    messageId: '<mail@example.test>', inReplyTo: null, references: [], from: 'recruiter@example.test',
    to: 'intake@example.test', subject: 'Application update', text: 'Hello Example GmbH', date: null, urls: [], confirmation: false,
  }, [
    { cardId: 'card-1', company: 'Example GmbH', role: 'Engineer' },
    { cardId: 'card-2', company: 'Example GmbH', role: 'Designer' },
  ]);
  assert.equal(result.kind, 'review');
});

test('Given HTML-only forwarded MIME, when parsed, then extracts quoted source URL and thread headers', async () => {
  const raw = [
    'From: user@example.test', 'To: intake@example.test', 'Subject: Fwd: Interview',
    'Message-ID: <forward@example.test>', 'Content-Type: text/html; charset=utf-8', '',
    '<p>Forwarded message</p><p>Subject: Interview</p><p>Message-ID: &lt;original@example.test&gt;</p><p>See https://jobs.example.test/42</p>',
  ].join('\r\n');
  const result = await parseForwardedMail(new TextEncoder().encode(raw));
  assert.equal(result.messageId, '<forward@example.test>');
  assert.equal(result.inReplyTo, null);
  assert.ok(result.text.includes('<original@example.test>'));
  assert.ok(result.urls.includes('https://jobs.example.test/42'));
});
