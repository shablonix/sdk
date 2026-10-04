# `@shablonix/sdk`

TypeScript client for the Shablonix API. Generate PDFs, compile email letters, and verify account webhooks.

Keep the API key on your server. Do not put it in frontend JavaScript.

Working example: [shablonix/crm-demo](https://github.com/shablonix/crm-demo) mints embed sessions and streams PDFs with this SDK.

Full docs: https://shablonix.online/docs/packages

## Install

```bash
npm install @shablonix/sdk
```

Ships ESM and CommonJS builds with TypeScript types. Needs a runtime with `fetch` and WebCrypto: Node 18+, Deno, Bun, or edge workers.

```ts
import { Shablonix } from '@shablonix/sdk';      // ESM
const { Shablonix } = require('@shablonix/sdk'); // CommonJS
```

## Three ways to get a document

| Method | You get | Stored? |
| --- | --- | --- |
| `generatePdf()` | Completed metadata with `fileUrl` | Yes, 72 h |
| `generatePdf({ async: true })`, `generatePdfAndWait()` | A pending job, then poll or webhook | Yes, 72 h |
| `generatePdfStream()`, `generatePdfBytes()` | The file itself in the response | No |

`generate()`, `generateStream()`, and `generateBytes()` take a `format` (`pdf`, `png`, `html`, `docx`) and work the same way.

## Generate a PDF

Synchronous call. It resolves once the file is ready, with `fileUrl` for download. If the server takes longer than its 60-second synchronous window and answers `202`, the SDK polls until the document completes (up to 2 more minutes). The request itself defaults to a 90-second timeout. An explicit `timeoutMs` bounds the whole call. If you have configured account webhooks, Shablonix still POSTs `document.completed` (or `document.failed`) to that URL.

```ts
import { Shablonix } from '@shablonix/sdk';

const client = new Shablonix(process.env.SHABLONIX_API_KEY!);

const pdf = await client.generatePdf({
  templateId: 'meridian-invoice',
  data: {
    invoice: { number: 'INV-2026-001', issueDate: '2026-04-06' },
    customer: { name: 'Acme Corp', email: 'billing@acme.test' },
    totals: { totalOutstanding: 1900 },
  },
});

console.log(pdf.id, pdf.status, pdf.fileUrl);

const bytes = await client.downloadGenerationBytes(pdf);
```

## Stream the file directly

One request, no download URL, and nothing kept on Shablonix. `body` is a web `ReadableStream`. Pipe it to your HTTP response, S3, or disk.

```ts
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const pdf = await client.generatePdfStream({
  templateId: 'meridian-invoice',
  data: { invoice: { number: 'INV-2026-001' } },
});

console.log(pdf.id, pdf.contentLength, pdf.outputRetention); // outputRetention: 'none'
await pipeline(Readable.fromWeb(pdf.body), createWriteStream('invoice.pdf'));

// Or buffer it:
const bytes = await client.generatePdfBytes({ templateId: 'meridian-invoice', data: {} });
```

The server renders the whole file before it sends the first byte, so `timeoutMs` covers rendering. Reading `body` has no timeout. Call `pdf.body.cancel()` if you stop reading early. The generation is billed once rendering finishes, even if you never read the body. `async` and `webhookUrl` are not accepted here.

## Safe retries with `idempotencyKey`

Every generate method, and `compileEmail()`, takes an `idempotencyKey` option (8-200 visible ASCII characters). The SDK sends it as the `Idempotency-Key` header. Repeating the key with the same data within 24 hours returns the original result without rendering or charging again.

```ts
const pdf = await client.generatePdfStream(
  { templateId: 'meridian-invoice', data: invoice },
  { idempotencyKey: `invoice-${invoice.number}` },
);
```

A keyed stream keeps the output for the standard retention window so that a retry can be replayed (`outputRetention: 'temporary'`). Omit the key if the file must never be stored. The API answers `409` (`ShablonixApiError`) when the key was used with different data or the first request is still rendering, and `410` once the key has expired. For a still-rendering `409`, `error.body` includes `status_url`; retry with the same key. A stream without a key that takes longer than 60 seconds gets a `504`: the render is cancelled, nothing is stored, and it is not charged. Send a key, or use async, for large documents.

## Async generate, then poll

```ts
const accepted = await client.generatePdf({
  templateId: 'meridian-invoice',
  data: { invoice: { number: 'INV-2026-001' } },
  async: true,
});

const completed = await client.waitForGeneration(accepted, {
  intervalMs: 2000,
  timeoutMs: 120000,
});

console.log(completed.fileUrl);
```

`generatePdfAndWait()` is the same: enqueue, then poll until `completed` or `failed`.

## Per-request webhook

Optional extra callback for this job only. These POSTs are not signed. Prefer account webhooks if you need HMAC verification.

```ts
await client.generatePdf({
  templateId: 'meridian-invoice',
  data: { invoice: { number: 'INV-2026-001' } },
  webhookUrl: 'https://your-app.example/webhooks/generation',
  async: true,
});
```

## Account webhooks

Configure once. Every later generate — sync or async — delivers `document.completed` / `document.failed` when those events are selected.

```ts
const config = await client.configureWebhook({
  url: 'https://your-app.example/webhooks/shablonix',
  events: ['document.completed', 'document.failed', 'batch.completed', 'batch.failed'],
});

console.log(config.secret); // store this; it is shown once if Shablonix generated it
```

Receive:

```ts
import { constructWebhookEvent } from '@shablonix/sdk';

app.post('/webhooks/shablonix', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = await constructWebhookEvent(
    req.body,
    req.headers,
    process.env.SHABLONIX_WEBHOOK_SECRET!,
  );

  if (event.type === 'document.completed') {
    const pdf = await client.downloadGenerationBytes(event.data.id);
    // store pdf, then 200
  }

  res.status(200).json({ received: true });
});
```

Payload `file_url` and `status_url` are API-relative (`/v1/generate/{id}/download`). Download with `downloadGenerationBytes(event.data.id)` or prefix `https://api.shablonix.online`.

## Compile an email letter

`POST /v1/emails/compile`. Returns inbox HTML, text, and provider-shaped payloads. Compiled mail is not stored.

```ts
const letter = await client.compileEmail({
  templateId: 'cmEmailTemplateId',
  data: {
    customer: { name: 'Ada Lovelace' },
    invoice: { number: 'INV-2048', total: '€149.00' },
  },
});

await resend.emails.send({
  from: 'billing@your-app.example',
  to: 'ada@example.com',
  ...letter.providers.resend,
});
```

## Batch PDFs

```ts
const batch = await client.generateBatchPdf({
  templateId: 'meridian-invoice',
  items: [{ data: { id: 1 } }, { data: { id: 2 } }],
});

const done = await client.waitForBatchGeneration(batch);
console.log(done.results.map((item) => item.fileUrl));
```

## Embeddable email editor

Mint a one-time iframe URL from your backend, then mount it in the browser with [`@shablonix/embed`](https://www.npmjs.com/package/@shablonix/embed).

```ts
// server
const session = await client.createEmbedSession({
  origin: 'https://your-app.example',
  starter: 'lookbook',
  userId: accountId,
});
```

```ts
// browser
import { mountEmailEditor } from '@shablonix/embed';

const editor = mountEmailEditor('#email-editor', { src: session.url });
```

## Notes

- `generate()` and `generatePdf()` return the real generation `id` as both `id` and `requestId`.
- Generation responses include `outputRetention` (`none` or `temporary`) and, for PDFs, `pdfRenderer`.
- `statusUrl` and `fileUrl` are normalized to absolute URLs on generate/status responses.
- Account webhooks are signed (`X-Shablonix-Signature`). Per-request `webhookUrl` callbacks are not.
- If account webhooks are configured, they fire when the PDF is ready even if the HTTP generate call already returned the completed file.
