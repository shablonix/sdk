import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

import {
  Shablonix,
  ShablonixApiError,
  constructWebhookEvent,
  verifyWebhookSignature,
} from '../dist/index.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test('generatePdf normalizes async generation responses and polls to completion', async () => {
  let generationPolls = 0;
  let lastAuthHeader;

  await withServer(async (req, res) => {
    lastAuthHeader = req.headers.authorization;

    if (req.method === 'POST' && req.url === '/v1/generate') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-id', 'trace_gen_create');
      res.end(
        JSON.stringify({
          id: 'gen_123',
          status: 'pending',
          format: 'pdf',
          template_id: 'tpl_invoice_basic',
          created_at: '2026-04-06T12:00:00.000Z',
          expires_at: '2026-04-09T12:00:00.000Z',
          status_url: '/v1/generate/gen_123',
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/generate/gen_123') {
      generationPolls += 1;
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-id', `trace_poll_${generationPolls}`);

      if (generationPolls === 1) {
        res.end(
          JSON.stringify({
            id: 'gen_123',
            status: 'processing',
            format: 'pdf',
            created_at: '2026-04-06T12:00:00.000Z',
            expires_at: '2026-04-09T12:00:00.000Z',
            status_url: '/v1/generate/gen_123',
          }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          id: 'gen_123',
          status: 'completed',
          format: 'pdf',
          created_at: '2026-04-06T12:00:00.000Z',
          completed_at: '2026-04-06T12:00:03.000Z',
          expires_at: '2026-04-09T12:00:00.000Z',
          status_url: '/v1/generate/gen_123',
          file_url: '/v1/generate/gen_123/download',
          file_size: 1024,
          render_time_ms: 1400,
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/generate/gen_123/download') {
      res.setHeader('content-type', 'application/pdf');
      res.end(Buffer.from('pdf-bytes'));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  }, async (baseUrl) => {
    const client = new Shablonix({
      apiKey: 'tf_live_test_key',
      baseUrl,
      timeoutMs: 5000,
    });

    const accepted = await client.generatePdf({
      templateId: 'tpl_invoice_basic',
      data: { invoice: { number: 'INV-001' } },
      async: true,
    });

    assert.equal(accepted.requestId, 'gen_123');
    assert.equal(accepted.traceId, 'trace_gen_create');
    assert.equal(accepted.statusUrl, `${baseUrl}/v1/generate/gen_123`);

    const completed = await client.waitForGeneration(accepted, {
      intervalMs: 5,
      timeoutMs: 5000,
    });

    assert.equal(completed.status, 'completed');
    assert.equal(completed.pdfUrl, `${baseUrl}/v1/generate/gen_123/download`);
    assert.equal(completed.fileSize, 1024);

    const bytes = await client.downloadGenerationBytes(completed);
    assert.equal(Buffer.from(bytes).toString('utf8'), 'pdf-bytes');
    assert.equal(lastAuthHeader, 'Bearer tf_live_test_key');
  });
});

test('generateBatch normalizes batch responses', async () => {
  await withServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/generate/batch') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'batch_123',
          status: 'completed',
          template_id: 'tpl_batch',
          format: 'pdf',
          total_items: 2,
          completed_items: 2,
          failed_items: 0,
          created_at: '2026-04-06T12:00:00.000Z',
          completed_at: '2026-04-06T12:00:04.000Z',
          expires_at: '2026-04-09T12:00:00.000Z',
          results: [
            {
              index: 0,
              status: 'completed',
              file_url: '/v1/generate/gen_a/download',
            },
            {
              index: 1,
              status: 'completed',
              file_url: 'https://cdn.example.test/gen_b.pdf',
            },
          ],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  }, async (baseUrl) => {
    const client = new Shablonix({ apiKey: 'tf_live_test_key', baseUrl });
    const batch = await client.generateBatchPdf({
      templateId: 'tpl_batch',
      items: [{ data: { id: 1 } }, { data: { id: 2 } }],
    });

    assert.equal(batch.batchId, 'batch_123');
    assert.equal(batch.results[0].fileUrl, `${baseUrl}/v1/generate/gen_a/download`);
    assert.equal(batch.results[1].fileUrl, 'https://cdn.example.test/gen_b.pdf');
  });
});

test('compileEmail posts to /v1/emails/compile and normalizes the response', async () => {
  let receivedBody;

  await withServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/emails/compile') {
      receivedBody = await new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'email_123',
          template_id: 'tpl_invoice_email',
          subject: 'Invoice INV-001 is due',
          preheader: '€1900 outstanding',
          html: '<table><tr><td>Hello</td></tr></table>',
          text: 'Hello',
          providers: {
            resend: { subject: 'Invoice INV-001 is due', html: '<table></table>', text: 'Hello' },
            mailgun: { subject: 'Invoice INV-001 is due', html: '<table></table>', text: 'Hello' },
            brevo: { subject: 'Invoice INV-001 is due', htmlContent: '<table></table>', textContent: 'Hello' },
          },
          stored: false,
          compiled_at: '2026-04-06T12:00:00.000Z',
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  }, async (baseUrl) => {
    const client = new Shablonix({ apiKey: 'tf_live_test_key', baseUrl });
    const compiled = await client.compileEmail({
      templateId: 'tpl_invoice_email',
      data: { invoice: { number: 'INV-001' } },
    });

    assert.deepEqual(receivedBody, {
      data: { invoice: { number: 'INV-001' } },
      template_id: 'tpl_invoice_email',
    });
    assert.equal(compiled.id, 'email_123');
    assert.equal(compiled.templateId, 'tpl_invoice_email');
    assert.equal(compiled.subject, 'Invoice INV-001 is due');
    assert.equal(compiled.stored, false);
    assert.equal(compiled.compiledAt, '2026-04-06T12:00:00.000Z');
    assert.equal(compiled.providers.brevo.htmlContent, '<table></table>');
  });
});

test('generatePdf forwards webhookUrl for per-request callbacks', async () => {
  let receivedBody;

  await withServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/generate') {
      receivedBody = await new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      res.statusCode = 202;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'gen_wh',
          status: 'pending',
          format: 'pdf',
          template_id: 'tpl_invoice_basic',
          created_at: '2026-04-06T12:00:00.000Z',
          expires_at: '2026-04-09T12:00:00.000Z',
          status_url: '/v1/generate/gen_wh',
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  }, async (baseUrl) => {
    const client = new Shablonix({ apiKey: 'tf_live_test_key', baseUrl });
    const accepted = await client.generatePdf({
      templateId: 'tpl_invoice_basic',
      data: { invoice: { number: 'INV-001' } },
      webhookUrl: 'https://your-app.example/webhooks/shablonix',
      async: true,
    });

    assert.equal(accepted.status, 'pending');
    assert.equal(receivedBody.webhook_url, 'https://your-app.example/webhooks/shablonix');
    assert.equal(receivedBody.async, true);
  });
});

test('configureWebhook and getWebhookConfig use the webhook settings endpoints', async () => {
  await withServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/webhooks/settings') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          configured: true,
          url: 'https://example.com/webhooks/shablonix',
          secret: 'secret_123',
          events: ['document.completed', 'document.failed'],
          created_at: '2026-04-06T12:00:00.000Z',
          updated_at: '2026-04-06T12:00:00.000Z',
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/webhooks/settings') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          configured: true,
          url: 'https://example.com/webhooks/shablonix',
          secret: 'secret_123',
          events: ['document.completed'],
          created_at: '2026-04-06T12:00:00.000Z',
          updated_at: '2026-04-06T12:01:00.000Z',
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  }, async (baseUrl) => {
    const client = new Shablonix({ apiKey: 'tf_live_test_key', baseUrl });

    const configured = await client.configureWebhook({
      url: 'https://example.com/webhooks/shablonix',
      events: ['document.completed', 'document.failed'],
    });
    assert.equal(configured.configured, true);
    assert.equal(configured.secret, 'secret_123');

    const fetched = await client.getWebhookConfig();
    assert.deepEqual(fetched.events, ['document.completed']);
  });
});

test('verifyWebhookSignature and constructWebhookEvent accept valid signed payloads', async () => {
  const secret = 'super-secret';
  const payload = JSON.stringify({
    id: 'evt_123',
    type: 'document.completed',
    created_at: '2026-04-06T12:00:00.000Z',
    api_version: '2024-01-01',
    data: {
      id: 'gen_123',
      status: 'COMPLETED',
      file_url: 'https://cdn.example.test/gen_123.pdf',
    },
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  const headers = {
    'x-shablonix-signature': signature,
    'x-shablonix-timestamp': timestamp,
    'x-shablonix-event': 'document.completed',
    'x-shablonix-delivery-id': 'delivery_123',
  };

  const verified = await verifyWebhookSignature(payload, headers, secret);
  assert.equal(verified.event, 'document.completed');
  assert.equal(verified.deliveryId, 'delivery_123');

  const event = await constructWebhookEvent(payload, headers, secret);
  assert.equal(event.type, 'document.completed');
  assert.equal(event.data.id, 'gen_123');
});

test('api errors surface status, body, and trace id', async () => {
  await withServer(async (_req, res) => {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-request-id', 'trace_forbidden');
    res.end(JSON.stringify({ message: 'Usage limit exceeded' }));
  }, async (baseUrl) => {
    const client = new Shablonix({ apiKey: 'tf_live_test_key', baseUrl });

    await assert.rejects(
      client.generatePdf({
        templateId: 'tpl_invoice_basic',
        data: { invoice: { number: 'INV-001' } },
      }),
      (error) => {
        assert.ok(error instanceof ShablonixApiError);
        assert.equal(error.status, 403);
        assert.equal(error.traceId, 'trace_forbidden');
        assert.equal(error.message, 'Usage limit exceeded');
        return true;
      },
    );
  });
});

test('generatePdfStream requests the file directly and exposes a readable body', async () => {
  let received;

  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body) };

    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', 'attachment; filename="gen_stream.pdf"');
    res.setHeader('content-length', '9');
    res.setHeader('x-request-id', 'trace_stream');
    res.setHeader('x-shablonix-generation-id', 'gen_stream');
    res.setHeader('x-shablonix-output-retention', 'none');
    res.setHeader('x-shablonix-pdf-renderer', 'chromium');
    res.end(Buffer.from('%PDF-1.7\n'));
  }, async (baseUrl) => {
    const client = new Shablonix('tf_live_test_key', { baseUrl });
    const stream = await client.generatePdfStream({
      templateId: 'tpl_invoice_basic',
      data: { invoice: { number: 'INV-001' } },
      async: true,
      webhookUrl: 'https://example.test/hook',
    });

    assert.equal(received.headers.accept, 'application/pdf');
    assert.equal(received.headers['idempotency-key'], undefined);
    assert.deepEqual(received.body, {
      data: { invoice: { number: 'INV-001' } },
      format: 'pdf',
      template_id: 'tpl_invoice_basic',
    });
    assert.equal(stream.id, 'gen_stream');
    assert.equal(stream.traceId, 'trace_stream');
    assert.equal(stream.contentType, 'application/pdf');
    assert.equal(stream.contentLength, 9);
    assert.equal(stream.fileName, 'gen_stream.pdf');
    assert.equal(stream.outputRetention, 'none');
    assert.equal(stream.pdfRenderer, 'chromium');
    assert.equal(Buffer.from(await new Response(stream.body).arrayBuffer()).toString(), '%PDF-1.7\n');
  });
});

test('generateBytes forwards the idempotency key and format Accept header', async () => {
  let received;

  await withServer(async (req, res) => {
    received = req.headers;
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('x-shablonix-generation-id', 'gen_docx');
    res.setHeader('x-shablonix-output-retention', 'temporary');
    res.end(Buffer.from([137, 80, 78, 71]));
  }, async (baseUrl) => {
    const client = new Shablonix('tf_live_test_key', { baseUrl });
    const bytes = await client.generateBytes(
      { templateId: 'tpl', data: {}, format: 'docx' },
      { idempotencyKey: 'order-4815-receipt' },
    );

    assert.equal(received.accept, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(received['idempotency-key'], 'order-4815-receipt');
    assert.deepEqual([...bytes], [137, 80, 78, 71]);
  });
});

test('generatePdfStream surfaces API errors and rejects non-file responses', async () => {
  let mode = 'busy';

  await withServer(async (_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (mode === 'busy') {
      res.statusCode = 409;
      res.end(JSON.stringify({ message: 'Generation is still processing', id: 'gen_busy', status_url: '/v1/generate/gen_busy' }));
      return;
    }
    res.end(JSON.stringify({ id: 'gen_json', status: 'completed', format: 'pdf' }));
  }, async (baseUrl) => {
    const client = new Shablonix('tf_live_test_key', { baseUrl });
    const request = { templateId: 'tpl', data: {} };

    await assert.rejects(client.generatePdfStream(request), (error) => {
      assert.ok(error instanceof ShablonixApiError);
      assert.equal(error.status, 409);
      assert.equal(error.body.id, 'gen_busy');
      return true;
    });

    mode = 'json';
    await assert.rejects(client.generatePdfStream(request), /Expected a application\/pdf response stream/);
  });
});

test('a synchronous generate that the server leaves pending is polled to completion', async () => {
  let received;
  let polls = 0;
  const base = {
    id: 'gen_slow',
    format: 'pdf',
    created_at: '2026-04-06T12:00:00.000Z',
    expires_at: '2026-04-09T12:00:00.000Z',
    status_url: '/v1/generate/gen_slow',
  };

  await withServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      received = req.headers;
      res.statusCode = 202;
      res.setHeader('x-request-id', 'trace_slow');
      res.end(JSON.stringify({ ...base, status: 'pending' }));
      return;
    }
    polls += 1;
    res.end(JSON.stringify({ ...base, status: 'completed', file_url: '/v1/generate/gen_slow/download', output_retention: 'temporary' }));
  }, async (baseUrl) => {
    const client = new Shablonix('tf_live_test_key', { baseUrl });
    const pdf = await client.generatePdf({ templateId: 'tpl', data: {} }, { idempotencyKey: 'invoice-0001' });

    assert.equal(received.accept, 'application/json');
    assert.equal(received['idempotency-key'], 'invoice-0001');
    assert.equal(polls, 1);
    assert.equal(pdf.status, 'completed');
    assert.equal(pdf.traceId, 'trace_slow');
    assert.equal(pdf.outputRetention, 'temporary');
    assert.equal(pdf.fileUrl, `${baseUrl}/v1/generate/gen_slow/download`);
  });
});

test('default fetch keeps a global receiver (Cloudflare Workers reject this.fetchImpl())', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return realFetch(...args);
  };
  try {
    await withServer((req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://editor.example/embed/pdf?session=x', kind: 'pdf' }));
    }, async (baseUrl) => {
      const client = new Shablonix('tf_test_key', { baseUrl });
      const session = await client.createEmbedSession({ origin: 'https://app.example', templateId: 't1' });
      assert.equal(session.kind, 'pdf');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('getGeneration never sends the API key to another origin', async () => {
  const calls = [];
  const client = new Shablonix({
    apiKey: 'tf_live_test_key',
    baseUrl: 'https://api.shablonix.example',
    fetch: async (url, init) => {
      calls.push([url, init.headers.get('Authorization')]);
      return new Response('{}', { status: 200 });
    },
  });

  await assert.rejects(client.getGeneration('https://untrusted-host.example/collect'));
  await assert.rejects(client.getGeneration({ statusUrl: '//untrusted-host.example/collect' }));
  assert.deepEqual(calls, []);
});
