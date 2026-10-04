import {
  ShablonixApiError,
  ShablonixError,
  ShablonixBatchFailedError,
  ShablonixGenerationFailedError,
  ShablonixTimeoutError,
} from './errors.js';
import type {
  BatchGeneratePdfRequest,
  BatchGenerateRequest,
  BatchGenerationResponse,
  CompileEmailRequest,
  CompiledEmailResponse,
  ConfigureWebhookRequest,
  CreateEmbedSessionRequest,
  EmbedSessionResponse,
  DownloadOptions,
  EmailUsageResponse,
  GenerateAndWaitOptions,
  GenerateOptions,
  GeneratePdfRequest,
  GeneratePdfStreamRequest,
  GenerateRequest,
  GenerateStreamRequest,
  GenerationStream,
  GenerationResponse,
  GenerationStatus,
  GenerationOptions,
  GenerationUsageResponse,
  OutputFormat,
  ShablonixClientOptions,
  WaitForBatchOptions,
  WaitForGenerationOptions,
  WebhookAckResponse,
  WebhookConfigResponse,
} from './types.js';

type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  auth?: boolean;
  headers?: HeadersInit;
};

type GenerationLookup = string | Pick<GenerationResponse, 'id' | 'requestId' | 'statusUrl' | 'fileUrl' | 'status'>;
type BatchLookup = string | Pick<BatchGenerationResponse, 'id' | 'batchId' | 'status' | 'results'>;

type RawGenerationResponse = {
  id: string;
  status: string;
  format: string;
  template_id?: string;
  created_at: string;
  completed_at?: string;
  expires_at: string;
  file_url?: string;
  status_url?: string;
  stale_at?: string;
  expired_at?: string;
  file_size?: number;
  render_time_ms?: number;
  output_retention?: string;
  pdf_renderer?: string;
  error?: string;
  user_id?: string;
  api_key_id?: string;
};

type RawBatchGenerationResponse = {
  id: string;
  status: string;
  template_id: string;
  format: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  created_at: string;
  completed_at?: string;
  expires_at: string;
  stale_at?: string;
  expired_at?: string;
  webhook_url?: string;
  results?: Array<{
    index: number;
    status: string;
    file_url?: string;
    error?: string;
  }>;
};

type RawWebhookConfigResponse = {
  configured: boolean;
  url?: string;
  secret?: string;
  events?: string[];
  created_at?: string;
  updated_at?: string;
};

const DEFAULT_BASE_URL = 'https://api.shablonix.online';
const DEFAULT_TIMEOUT_MS = 30_000;
// Synchronous generation can wait up to 60s for a worker on the server, so the
// client must outlast it or it aborts a render the server still completes and bills.
const DEFAULT_SYNC_GENERATION_TIMEOUT_MS = 90_000;
const SDK_HEADER_VALUE = '@shablonix/sdk ts/0.3.1';

const CONTENT_TYPES: Record<OutputFormat, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function normalizeStatus(value: string): GenerationStatus {
  return value.toLowerCase() as GenerationStatus;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function toAbsoluteUrl(baseUrl: string, value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return new URL(value, ensureTrailingSlash(baseUrl)).toString();
}

function serializeOptions(options?: GenerationOptions): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }

  const payload: Record<string, unknown> = {};

  if (options.pageSize) {
    payload.page_size = options.pageSize;
  }

  if (options.orientation) {
    payload.orientation = options.orientation;
  }

  if (options.margin) {
    payload.margin = { ...options.margin };
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}

function buildGenerationPayload(request: GenerateRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    data: request.data,
    format: request.format,
  };

  if (request.templateId) {
    payload.template_id = request.templateId;
  }

  if (request.template) {
    payload.template = request.template;
  }

  if (request.docxTemplateId) {
    payload.docx_template_id = request.docxTemplateId;
  }

  const options = serializeOptions(request.options);
  if (options) {
    payload.options = options;
  }

  if (request.webhookUrl) {
    payload.webhook_url = request.webhookUrl;
  }

  if (typeof request.async === 'boolean') {
    payload.async = request.async;
  }

  return payload;
}

function buildBatchPayload(request: BatchGenerateRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    template_id: request.templateId,
    items: request.items,
    format: request.format,
  };

  const options = serializeOptions(request.options);
  if (options) {
    payload.options = options;
  }

  if (request.webhookUrl) {
    payload.webhook_url = request.webhookUrl;
  }

  return payload;
}

function idempotencyHeaders(idempotencyKey?: string): HeadersInit | undefined {
  return idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;
}

function fileNameFromDisposition(value: string | null): string | undefined {
  return value?.match(/filename="?([^";]+)"?/i)?.[1];
}

function resolveGenerationLookup(input: GenerationLookup): {
  id?: string;
  statusUrl?: string;
  fileUrl?: string;
  status?: GenerationStatus;
} {
  if (typeof input === 'string') {
    if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('/')) {
      return { statusUrl: input };
    }

    return { id: input };
  }

  return {
    id: input.id || input.requestId,
    statusUrl: input.statusUrl,
    fileUrl: input.fileUrl,
    status: input.status,
  };
}

function resolveBatchLookup(input: BatchLookup): {
  id?: string;
  status?: GenerationStatus;
} {
  if (typeof input === 'string') {
    if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('/')) {
      const match = input.match(/\/batch\/([^/?#]+)/);
      return { id: match?.[1] };
    }

    return { id: input };
  }

  return {
    id: input.id || input.batchId,
    status: input.status,
  };
}

function assertTemplateSource(
  request: Pick<GenerateRequest, 'templateId' | 'template' | 'docxTemplateId'>,
  method: string,
): void {
  if (!request.templateId && !request.template && !request.docxTemplateId) {
    throw new Error(`${method} requires templateId, template, or docxTemplateId`);
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export class Shablonix {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;

  private readonly fetchImpl: typeof fetch;
  private readonly syncGenerationTimeoutMs: number;

  constructor(apiKey: string, options?: Omit<ShablonixClientOptions, 'apiKey'>);
  constructor(options: ShablonixClientOptions);
  constructor(
    apiKeyOrOptions: string | ShablonixClientOptions,
    maybeOptions: Omit<ShablonixClientOptions, 'apiKey'> = {},
  ) {
    const options =
      typeof apiKeyOrOptions === 'string'
        ? { ...maybeOptions, apiKey: apiKeyOrOptions }
        : apiKeyOrOptions;

    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.syncGenerationTimeoutMs = options.timeoutMs || DEFAULT_SYNC_GENERATION_TIMEOUT_MS;

    if (!options.fetch && typeof globalThis.fetch !== 'function') {
      throw new Error('Fetch is not available in this runtime. Pass a custom fetch implementation.');
    }

    // Never store the bare global: Cloudflare Workers throw "Illegal invocation"
    // when fetch is called as a method of another object (this.fetchImpl()).
    this.fetchImpl = options.fetch || ((input, init) => globalThis.fetch(input, init));
  }

  async createEmbedSession(
    request: CreateEmbedSessionRequest,
    options: DownloadOptions = {},
  ): Promise<EmbedSessionResponse> {
    const { data } = await this.requestJson<EmbedSessionResponse>(
      'POST',
      '/v1/embed/sessions',
      {
        origin: request.origin,
        templateId: request.templateId,
        starter: request.starter,
        kind: request.kind,
        medium: request.medium,
        userId: request.userId,
        name: request.name,
      },
      options,
    );
    return data;
  }

  async compileEmail(
    request: CompileEmailRequest,
    options: GenerateOptions = {},
  ): Promise<CompiledEmailResponse> {
    if (!request.templateId && !request.template) {
      throw new Error('compileEmail() requires templateId or template');
    }

    const payload: Record<string, unknown> = {
      data: request.data,
    };
    if (request.templateId) {
      payload.template_id = request.templateId;
    }
    if (request.template) {
      payload.template = request.template;
    }

    const { data } = await this.requestJson<{
      id: string;
      template_id?: string;
      subject: string;
      preheader: string;
      html: string;
      text: string;
      providers: CompiledEmailResponse['providers'];
      stored: false;
      compiled_at: string;
    }>('POST', '/v1/emails/compile', payload, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      headers: idempotencyHeaders(options.idempotencyKey),
    });

    return {
      id: data.id,
      templateId: data.template_id,
      subject: data.subject,
      preheader: data.preheader,
      html: data.html,
      text: data.text,
      providers: data.providers,
      stored: false,
      compiledAt: data.compiled_at,
    };
  }

  async getEmailUsage(options: DownloadOptions = {}): Promise<EmailUsageResponse> {
    const { data } = await this.requestJson<EmailUsageResponse>(
      'GET',
      '/v1/emails/usage/current',
      undefined,
      options,
    );
    return data;
  }

  async getGenerationUsage(options: DownloadOptions = {}): Promise<GenerationUsageResponse> {
    const { data } = await this.requestJson<GenerationUsageResponse>(
      'GET',
      '/v1/generate/usage/current',
      undefined,
      options,
    );
    return data;
  }

  /**
   * Generate a document and return its metadata. Without `async` or
   * `webhookUrl` the call resolves once the file is ready; if the server hands
   * back a still-pending job, the SDK polls it to completion.
   */
  async generate(request: GenerateRequest, options: GenerateOptions = {}): Promise<GenerationResponse> {
    assertTemplateSource(request, 'generate()');
    const synchronous = !request.async && !request.webhookUrl;
    const timeoutMs = options.timeoutMs ?? (synchronous ? this.syncGenerationTimeoutMs : undefined);
    const deadline = Date.now() + (timeoutMs ?? this.timeoutMs);

    const { data, traceId } = await this.requestJson<RawGenerationResponse>(
      'POST',
      '/v1/generate',
      buildGenerationPayload(request),
      { signal: options.signal, timeoutMs, headers: idempotencyHeaders(options.idempotencyKey) },
    );

    const generation = this.normalizeGeneration(data, traceId);
    if (!synchronous || (generation.status !== 'pending' && generation.status !== 'processing')) {
      return generation;
    }

    // An explicit timeoutMs bounds the whole call; otherwise poll with the standard wait budget.
    const settled = await this.waitForGeneration(generation, {
      signal: options.signal,
      timeoutMs: options.timeoutMs === undefined ? undefined : Math.max(1, deadline - Date.now()),
    });
    return { ...settled, traceId: generation.traceId };
  }

  async generatePdf(request: GeneratePdfRequest, options: GenerateOptions = {}): Promise<GenerationResponse> {
    return this.generate({ ...request, format: 'pdf' }, options);
  }

  async generateAndWait(
    request: GenerateRequest,
    options: GenerateAndWaitOptions = {},
  ): Promise<GenerationResponse> {
    const { idempotencyKey, ...waitOptions } = options;
    const initial = await this.generate(
      { ...request, async: true },
      { signal: options.signal, idempotencyKey },
    );
    return this.waitForGeneration(initial, waitOptions);
  }

  async generatePdfAndWait(
    request: GeneratePdfRequest,
    options: GenerateAndWaitOptions = {},
  ): Promise<GenerationResponse> {
    return this.generateAndWait({ ...request, format: 'pdf' }, options);
  }

  /**
   * Generate a document and receive its bytes directly in the response.
   * Nothing is stored: `outputRetention` is `none`, there is no download URL,
   * and the bytes can only be read once. With `idempotencyKey`, the server keeps
   * the output so that a retry with the same key replays it without billing again.
   *
   * The server renders the whole file before sending the first byte;
   * `timeoutMs` covers that wait, not reading `body`.
   */
  async generateStream(
    request: GenerateStreamRequest,
    options: GenerateOptions = {},
  ): Promise<GenerationStream> {
    assertTemplateSource(request, 'generateStream()');
    const { async: _async, webhookUrl: _webhookUrl, ...syncRequest } = request as GenerateRequest;
    const contentType = CONTENT_TYPES[request.format];
    const headers = new Headers(idempotencyHeaders(options.idempotencyKey));
    headers.set('Accept', contentType);

    const response = await this.requestRaw('POST', '/v1/generate', buildGenerationPayload(syncRequest), {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.syncGenerationTimeoutMs,
      headers,
    });
    const traceId = response.headers.get('x-request-id') ?? undefined;

    if (!response.ok) {
      throw await this.toApiError(response, traceId);
    }

    const id = response.headers.get('x-shablonix-generation-id');
    if (!response.body || !id || !(response.headers.get('content-type') || '').startsWith(contentType)) {
      await response.body?.cancel();
      throw new ShablonixError(`Expected a ${contentType} response stream from POST /v1/generate`);
    }

    const contentLength = Number(response.headers.get('content-length'));
    return {
      id,
      traceId,
      format: request.format,
      contentType,
      contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined,
      fileName: fileNameFromDisposition(response.headers.get('content-disposition')),
      outputRetention: (response.headers.get('x-shablonix-output-retention') || 'none') as GenerationStream['outputRetention'],
      pdfRenderer: response.headers.get('x-shablonix-pdf-renderer') ?? undefined,
      body: response.body,
    };
  }

  async generatePdfStream(
    request: GeneratePdfStreamRequest,
    options: GenerateOptions = {},
  ): Promise<GenerationStream> {
    return this.generateStream({ ...request, format: 'pdf' }, options);
  }

  /** `generateStream()`, buffered into memory. */
  async generateBytes(
    request: GenerateStreamRequest,
    options: GenerateOptions = {},
  ): Promise<Uint8Array> {
    const stream = await this.generateStream(request, options);
    return new Uint8Array(await new Response(stream.body).arrayBuffer());
  }

  async generatePdfBytes(
    request: GeneratePdfStreamRequest,
    options: GenerateOptions = {},
  ): Promise<Uint8Array> {
    return this.generateBytes({ ...request, format: 'pdf' }, options);
  }

  async getGeneration(input: GenerationLookup, options: DownloadOptions = {}): Promise<GenerationResponse> {
    const lookup = resolveGenerationLookup(input);
    const statusPath = lookup.statusUrl || `/v1/generate/${lookup.id}`;
    const { data, traceId } = await this.requestJson<RawGenerationResponse>(
      'GET',
      statusPath,
      undefined,
      options,
    );

    return this.normalizeGeneration(data, traceId);
  }

  async waitForGeneration(
    input: GenerationLookup,
    options: WaitForGenerationOptions = {},
  ): Promise<GenerationResponse> {
    const {
      intervalMs = 2000,
      timeoutMs = 120_000,
      signal,
      throwOnFailed = true,
      onPoll,
    } = options;

    const lookup = resolveGenerationLookup(input);
    if (lookup.status === 'completed' && typeof input !== 'string') {
      return input as GenerationResponse;
    }

    if (lookup.status === 'failed' && typeof input !== 'string') {
      if (throwOnFailed) {
        throw new ShablonixGenerationFailedError(input as GenerationResponse);
      }

      return input as GenerationResponse;
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
      }

      const generation = await this.getGeneration(input, { signal, timeoutMs });
      if (onPoll) {
        await onPoll(generation);
      }

      if (generation.status === 'completed') {
        return generation;
      }

      if (generation.status === 'failed') {
        if (throwOnFailed) {
          throw new ShablonixGenerationFailedError(generation);
        }

        return generation;
      }

      if (Date.now() >= deadline) {
        throw new ShablonixTimeoutError(
          `Timed out waiting for generation ${generation.id} after ${timeoutMs}ms`,
        );
      }

      await sleep(intervalMs, signal);
      input = generation;
    }
  }

  async downloadGeneration(
    input: GenerationLookup,
    options: DownloadOptions = {},
  ): Promise<Response> {
    const lookup = resolveGenerationLookup(input);
    const target = lookup.fileUrl || `/v1/generate/${lookup.id}/download`;
    const absoluteUrl = new URL(target, ensureTrailingSlash(this.baseUrl));
    const apiOrigin = new URL(this.baseUrl).origin;

    const headers = new Headers();
    headers.set('X-Shablonix-SDK', SDK_HEADER_VALUE);

    if (absoluteUrl.origin === apiOrigin) {
      headers.set('Authorization', `Bearer ${this.apiKey}`);
    }

    const response = await this.requestRaw('GET', absoluteUrl.toString(), undefined, {
      ...options,
      auth: false,
      headers,
    });

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    return response;
  }

  async downloadGenerationBytes(
    input: GenerationLookup,
    options: DownloadOptions = {},
  ): Promise<Uint8Array> {
    const response = await this.downloadGeneration(input, options);
    return new Uint8Array(await response.arrayBuffer());
  }

  async generateBatch(
    request: BatchGenerateRequest,
    options: DownloadOptions = {},
  ): Promise<BatchGenerationResponse> {
    const { data, traceId } = await this.requestJson<RawBatchGenerationResponse>(
      'POST',
      '/v1/generate/batch',
      buildBatchPayload(request),
      options,
    );

    return this.normalizeBatch(data, traceId);
  }

  async generateBatchPdf(
    request: BatchGeneratePdfRequest,
    options: DownloadOptions = {},
  ): Promise<BatchGenerationResponse> {
    return this.generateBatch({ ...request, format: 'pdf' }, options);
  }

  async getBatchGeneration(
    input: BatchLookup,
    options: DownloadOptions = {},
  ): Promise<BatchGenerationResponse> {
    const lookup = resolveBatchLookup(input);
    const { data, traceId } = await this.requestJson<RawBatchGenerationResponse>(
      'GET',
      `/v1/generate/batch/${lookup.id}`,
      undefined,
      options,
    );

    return this.normalizeBatch(data, traceId);
  }

  async waitForBatchGeneration(
    input: BatchLookup,
    options: WaitForBatchOptions = {},
  ): Promise<BatchGenerationResponse> {
    const {
      intervalMs = 2000,
      timeoutMs = 120_000,
      signal,
      throwOnFailed = true,
      onPoll,
    } = options;

    const lookup = resolveBatchLookup(input);
    if (lookup.status === 'completed' && typeof input !== 'string') {
      return input as BatchGenerationResponse;
    }

    if (lookup.status === 'failed' && typeof input !== 'string') {
      if (throwOnFailed) {
        throw new ShablonixBatchFailedError(input as BatchGenerationResponse);
      }

      return input as BatchGenerationResponse;
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
      }

      const batch = await this.getBatchGeneration(input, { signal, timeoutMs });
      if (onPoll) {
        await onPoll(batch);
      }

      if (batch.status === 'completed') {
        return batch;
      }

      if (batch.status === 'failed') {
        if (throwOnFailed) {
          throw new ShablonixBatchFailedError(batch);
        }

        return batch;
      }

      if (Date.now() >= deadline) {
        throw new ShablonixTimeoutError(
          `Timed out waiting for batch ${batch.id} after ${timeoutMs}ms`,
        );
      }

      await sleep(intervalMs, signal);
      input = batch;
    }
  }

  async getWebhookConfig(options: DownloadOptions = {}): Promise<WebhookConfigResponse> {
    const { data } = await this.requestJson<RawWebhookConfigResponse>(
      'GET',
      '/v1/webhooks/settings',
      undefined,
      options,
    );

    return {
      configured: data.configured,
      url: data.url,
      secret: data.secret,
      events: data.events as WebhookConfigResponse['events'],
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async configureWebhook(
    request: ConfigureWebhookRequest,
    options: DownloadOptions = {},
  ): Promise<WebhookConfigResponse> {
    const { data } = await this.requestJson<RawWebhookConfigResponse>(
      'POST',
      '/v1/webhooks/settings',
      request,
      options,
    );

    return {
      configured: data.configured,
      url: data.url,
      secret: data.secret,
      events: data.events as WebhookConfigResponse['events'],
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async deleteWebhook(options: DownloadOptions = {}): Promise<WebhookAckResponse> {
    const { data } = await this.requestJson<WebhookAckResponse>(
      'DELETE',
      '/v1/webhooks/settings',
      undefined,
      options,
    );

    return data;
  }

  async sendTestWebhook(options: DownloadOptions = {}): Promise<WebhookAckResponse> {
    const { data } = await this.requestJson<WebhookAckResponse>(
      'POST',
      '/v1/webhooks/settings/test',
      undefined,
      options,
    );

    return data;
  }

  private normalizeGeneration(raw: RawGenerationResponse, traceId?: string): GenerationResponse {
    const format = raw.format.toLowerCase() as GenerationResponse['format'];
    const fileUrl = toAbsoluteUrl(this.baseUrl, raw.file_url);

    return {
      id: raw.id,
      requestId: raw.id,
      traceId,
      status: normalizeStatus(raw.status),
      format,
      templateId: raw.template_id,
      createdAt: raw.created_at,
      completedAt: raw.completed_at,
      expiresAt: raw.expires_at,
      fileUrl,
      pdfUrl: format === 'pdf' ? fileUrl : undefined,
      statusUrl: toAbsoluteUrl(this.baseUrl, raw.status_url || `/v1/generate/${raw.id}`)!,
      staleAt: raw.stale_at,
      expiredAt: raw.expired_at,
      fileSize: raw.file_size,
      renderTimeMs: raw.render_time_ms,
      outputRetention: raw.output_retention as GenerationResponse['outputRetention'],
      pdfRenderer: raw.pdf_renderer,
      error: raw.error,
      userId: raw.user_id,
      apiKeyId: raw.api_key_id,
    };
  }

  private normalizeBatch(raw: RawBatchGenerationResponse, traceId?: string): BatchGenerationResponse {
    return {
      id: raw.id,
      batchId: raw.id,
      traceId,
      status: normalizeStatus(raw.status),
      templateId: raw.template_id,
      format: raw.format.toLowerCase() as BatchGenerationResponse['format'],
      totalItems: raw.total_items,
      completedItems: raw.completed_items,
      failedItems: raw.failed_items,
      createdAt: raw.created_at,
      completedAt: raw.completed_at,
      expiresAt: raw.expires_at,
      staleAt: raw.stale_at,
      expiredAt: raw.expired_at,
      webhookUrl: raw.webhook_url,
      results: (raw.results || []).map((item) => ({
        index: item.index,
        status: normalizeStatus(item.status),
        fileUrl: toAbsoluteUrl(this.baseUrl, item.file_url),
        error: item.error,
      })),
    };
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ data: T; traceId?: string }> {
    const response = await this.requestRaw(method, path, body, options);
    const traceId = response.headers.get('x-request-id') ?? undefined;

    if (!response.ok) {
      throw await this.toApiError(response, traceId);
    }

    const text = await response.text();
    const data = text ? (JSON.parse(text) as T) : (undefined as T);
    return { data, traceId };
  }

  private async requestRaw(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<Response> {
    const url = new URL(path, ensureTrailingSlash(this.baseUrl)).toString();
    const headers = new Headers(options.headers);
    headers.set('X-Shablonix-SDK', SDK_HEADER_VALUE);

    if (options.auth !== false) {
      headers.set('Authorization', `Bearer ${this.apiKey}`);
    }

    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timeout = setTimeout(() => {
      controller.abort(new ShablonixTimeoutError());
    }, timeoutMs);

    const onAbort = () => {
      controller.abort(options.signal?.reason);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (
        error instanceof ShablonixTimeoutError ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw new ShablonixTimeoutError();
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async toApiError(response: Response, traceId?: string): Promise<ShablonixApiError> {
    const body = await this.parseErrorBody(response);
    const message = this.extractErrorMessage(body) || `Shablonix API request failed with status ${response.status}`;
    return new ShablonixApiError(
      message,
      response.status,
      body,
      traceId ?? response.headers.get('x-request-id') ?? undefined,
    );
  }

  private async parseErrorBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private extractErrorMessage(body: unknown): string | undefined {
    if (typeof body === 'string' && body.trim()) {
      return body;
    }

    if (body && typeof body === 'object') {
      const message = (body as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }

      const nestedError = (body as { error?: { message?: unknown } }).error?.message;
      if (typeof nestedError === 'string' && nestedError.trim()) {
        return nestedError;
      }
    }

    return undefined;
  }
}

export { Shablonix as ShablonixClient };
