const MAX_FIELD_LENGTHS = {
  message: 8_000,
  contact: 500,
  company: 256,
  role: 256,
  jobUrl: 2_048,
  humanCheckToken: 2_048,
  humanCheckAnswer: 64,
} as const;
const CHALLENGE_TTL_MS = 5 * 60_000;

export interface WebsiteSubmission {
  message: string;
  contact: string;
  company: string;
  role: string;
  jobUrl?: string;
  humanCheckToken?: string;
  humanCheckAnswer?: string;
}

interface ChallengePayload {
  integrationId: string;
  first: number;
  second: number;
  nonce: string;
  expiresAt: number;
}

export function parseWebsiteSubmission(value: unknown): WebsiteSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Submission must be an object');
  const input = value as Record<string, unknown>;
  const submission = {
    message: boundedString(input.message, 'message', MAX_FIELD_LENGTHS.message),
    contact: boundedString(input.contact, 'contact', MAX_FIELD_LENGTHS.contact),
    company: boundedString(input.company, 'company', MAX_FIELD_LENGTHS.company),
    role: boundedString(input.role, 'role', MAX_FIELD_LENGTHS.role),
    ...(input.jobUrl === undefined ? {} : { jobUrl: boundedString(input.jobUrl, 'jobUrl', MAX_FIELD_LENGTHS.jobUrl) }),
    humanCheckToken: boundedString(input.humanCheckToken ?? '', 'humanCheckToken', MAX_FIELD_LENGTHS.humanCheckToken),
    humanCheckAnswer: boundedString(input.humanCheckAnswer ?? '', 'humanCheckAnswer', MAX_FIELD_LENGTHS.humanCheckAnswer),
  };
  if (submission.jobUrl && (!/^https?:\/\//i.test(submission.jobUrl) || /\s/.test(submission.jobUrl))) {
    throw new TypeError('jobUrl must be an HTTP(S) URL');
  }
  return submission;
}

export async function issueHumanChallenge(secret: string | Uint8Array, integrationId: string): Promise<{ token: string; prompt: string }> {
  if (!integrationId.trim() || integrationId.length > 256) throw new TypeError('integrationId is invalid');
  const first = randomDigit();
  const second = randomDigit();
  const payload: ChallengePayload = {
    integrationId,
    first,
    second,
    nonce: randomToken(18),
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };
  const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(secret, encoded);
  return { token: `${encoded}.${signature}`, prompt: `What is ${first} + ${second}?` };
}

export async function verifyHumanChallenge(
  secret: string | Uint8Array,
  integrationId: string,
  token: string,
  answer: string,
): Promise<{ nonce: string; expiresAt: number }> {
  if (typeof token !== 'string' || typeof answer !== 'string'
    || token.length > MAX_FIELD_LENGTHS.humanCheckToken || answer.length > MAX_FIELD_LENGTHS.humanCheckAnswer) {
    throw new TypeError('Human check is invalid');
  }
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra !== undefined) throw new TypeError('Human check is invalid');
  const expectedSignature = await sign(secret, encoded);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) throw new TypeError('Human check is invalid');
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as ChallengePayload;
  } catch {
    throw new TypeError('Human check is invalid');
  }
  if (payload.integrationId !== integrationId || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now()
    || typeof payload.nonce !== 'string' || payload.nonce.length < 16
    || !Number.isInteger(payload.first) || !Number.isInteger(payload.second)
    || String(payload.first + payload.second) !== answer.trim()) {
    throw new TypeError('Human check expired or incorrect');
  }
  return { nonce: payload.nonce, expiresAt: payload.expiresAt };
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be text`);
  const result = value.trim();
  if (new TextEncoder().encode(result).byteLength > maxLength) throw new TypeError(`${name} exceeds ${maxLength} bytes`);
  return result;
}

function randomDigit(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(1));
  return (bytes[0] % 9) + 1;
}

function randomToken(bytesLength: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytesLength)));
}

async function sign(secret: string | Uint8Array, value: string): Promise<string> {
  const keyBytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  if (keyBytes.byteLength < 32) throw new TypeError('Human-check secret must contain at least 32 bytes');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return mismatch === 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
