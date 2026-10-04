import type {
  ShablonixWebhookEvent,
  VerifiedWebhookMetadata,
  VerifyWebhookSignatureOptions,
} from './types.js';

type HeaderValue = string | string[] | undefined;
type HeadersLike = Headers | Record<string, HeaderValue>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readHeader(headers: HeadersLike, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  return undefined;
}

function toBytes(payload: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof payload === 'string') {
    return encoder.encode(payload);
  }

  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }

  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

function toText(payload: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof payload === 'string') {
    return payload;
  }

  return decoder.decode(toBytes(payload));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error('Web Crypto is not available in this runtime');
  }

  const key = await cryptoApi.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const digest = await cryptoApi.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyWebhookSignature(
  payload: string | ArrayBuffer | ArrayBufferView,
  headers: HeadersLike,
  secret: string,
  options: VerifyWebhookSignatureOptions = {},
): Promise<VerifiedWebhookMetadata> {
  const signature = readHeader(headers, 'x-shablonix-signature');
  const timestamp = readHeader(headers, 'x-shablonix-timestamp');
  const event = readHeader(headers, 'x-shablonix-event');
  const deliveryId = readHeader(headers, 'x-shablonix-delivery-id');

  if (!signature) {
    throw new Error('Missing X-Shablonix-Signature header');
  }

  if (!timestamp) {
    throw new Error('Missing X-Shablonix-Timestamp header');
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error('Invalid X-Shablonix-Timestamp header');
  }

  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const nowMs = (options.now ?? new Date()).getTime();
  const deltaSeconds = Math.abs(Math.floor(nowMs / 1000) - timestampSeconds);

  if (deltaSeconds > toleranceSeconds) {
    throw new Error('Webhook timestamp is outside the allowed tolerance');
  }

  const payloadText = toText(payload);
  const expectedSignature = await sign(`${timestamp}.${payloadText}`, secret);

  if (!constantTimeEqual(signature, expectedSignature)) {
    throw new Error('Invalid webhook signature');
  }

  return {
    timestamp: timestampSeconds,
    event: event ?? undefined,
    deliveryId: deliveryId ?? undefined,
  };
}

export async function constructWebhookEvent(
  payload: string | ArrayBuffer | ArrayBufferView,
  headers: HeadersLike,
  secret: string,
  options: VerifyWebhookSignatureOptions = {},
): Promise<ShablonixWebhookEvent> {
  await verifyWebhookSignature(payload, headers, secret, options);
  return JSON.parse(toText(payload)) as ShablonixWebhookEvent;
}
