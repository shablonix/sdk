export type OutputFormat = 'pdf' | 'html' | 'docx';

export type GenerationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type PageSize = 'A4' | 'A5' | 'A3' | 'Letter' | 'Legal';

export type Orientation = 'portrait' | 'landscape';

export interface MarginOptions {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface GenerationOptions {
  pageSize?: PageSize;
  orientation?: Orientation;
  margin?: MarginOptions;
}

export interface GenerateRequest {
  templateId?: string;
  template?: Record<string, unknown>;
  docxTemplateId?: string;
  data: Record<string, unknown>;
  format: OutputFormat;
  options?: GenerationOptions;
  webhookUrl?: string;
  async?: boolean;
}

export interface GeneratePdfRequest extends Omit<GenerateRequest, 'format'> {}

/** A synchronous request whose file bytes come back in the response body. */
export interface GenerateStreamRequest extends Omit<GenerateRequest, 'async' | 'webhookUrl'> {}

export interface GeneratePdfStreamRequest extends Omit<GenerateStreamRequest, 'format'> {}

export type OutputRetentionPolicy = 'none' | 'temporary';

export interface GenerationStream {
  /** Generation ID, from `X-Shablonix-Generation-ID`. */
  id: string;
  traceId?: string;
  format: OutputFormat;
  contentType: string;
  /** Byte length when the server sent `Content-Length`. */
  contentLength?: number;
  fileName?: string;
  /** `none` unless an idempotency key made the output durable for replay. */
  outputRetention: OutputRetentionPolicy;
  pdfRenderer?: string;
  /** File bytes. Consume it or call `body.cancel()` to release the connection. */
  body: ReadableStream<Uint8Array>;
}

export interface CreateEmbedSessionRequest {
  origin: string
  templateId?: string
  starter?: string
  kind?: 'email' | 'pdf' | 'website'
  medium?: 'email' | 'pdf' | 'website'
  userId?: string
  name?: string
}

export interface CompileEmailRequest {
  templateId?: string;
  template?: Record<string, unknown>;
  data: Record<string, unknown>;
}

export interface CompiledEmailProviders {
  resend: { subject: string; html: string; text: string };
  mailgun: { subject: string; html: string; text: string };
  brevo: { subject: string; htmlContent: string; textContent: string };
}

export interface CompiledEmailResponse {
  id: string;
  templateId?: string;
  subject: string;
  preheader: string;
  html: string;
  text: string;
  providers: CompiledEmailProviders;
  stored: false;
  compiledAt: string;
}

export interface GenerationUsageResponse {
  documentsUsed: number;
  documentsLimit: number;
  percentUsed: number;
  periodStart: string;
  periodEnd: string;
  canGenerate: boolean;
}

export interface EmailUsageResponse {
  emailsUsed: number;
  emailsLimit: number;
  percentUsed: number;
  periodStart: string;
  periodEnd: string;
  canCompile: boolean;
}

export interface EmbedSessionResponse {
  url: string
  expiresAt: string
  origin: string
  templateId: string | null
  starter: string | null
  kind?: 'email' | 'pdf' | 'website'
}

export interface BatchGenerationItem {
  data: Record<string, unknown>;
}

export interface BatchGenerateRequest {
  templateId: string;
  items: BatchGenerationItem[];
  format: OutputFormat;
  options?: GenerationOptions;
  webhookUrl?: string;
}

export interface BatchGeneratePdfRequest extends Omit<BatchGenerateRequest, 'format'> {}

export interface GenerationResponse {
  id: string;
  requestId: string;
  traceId?: string;
  status: GenerationStatus;
  format: OutputFormat;
  templateId?: string;
  createdAt: string;
  completedAt?: string;
  expiresAt: string;
  fileUrl?: string;
  pdfUrl?: string;
  statusUrl: string;
  staleAt?: string;
  expiredAt?: string;
  fileSize?: number;
  renderTimeMs?: number;
  outputRetention?: OutputRetentionPolicy;
  pdfRenderer?: string;
  error?: string;
  userId?: string;
  apiKeyId?: string;
}

export interface BatchGenerationResultItem {
  index: number;
  status: GenerationStatus;
  fileUrl?: string;
  error?: string;
}

export interface BatchGenerationResponse {
  id: string;
  batchId: string;
  traceId?: string;
  status: GenerationStatus;
  templateId: string;
  format: OutputFormat;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  createdAt: string;
  completedAt?: string;
  expiresAt: string;
  staleAt?: string;
  expiredAt?: string;
  webhookUrl?: string;
  results: BatchGenerationResultItem[];
}

export interface ShablonixClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface WaitForGenerationOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  throwOnFailed?: boolean;
  onPoll?: (generation: GenerationResponse) => void | Promise<void>;
}

export interface GenerateOptions extends DownloadOptions {
  /**
   * Sent as `Idempotency-Key` (8-200 visible ASCII characters). Reusing it with
   * identical data for 24 hours returns the same generation without another
   * render or charge.
   */
  idempotencyKey?: string;
}

export interface GenerateAndWaitOptions extends WaitForGenerationOptions {
  idempotencyKey?: string;
}

export interface WaitForBatchOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  throwOnFailed?: boolean;
  onPoll?: (batch: BatchGenerationResponse) => void | Promise<void>;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ConfigureWebhookRequest {
  url: string;
  secret?: string;
  events: WebhookEventType[];
}

export type WebhookEventType =
  | 'document.completed'
  | 'document.failed'
  | 'batch.progress'
  | 'batch.completed'
  | 'batch.failed';

export interface WebhookConfigResponse {
  configured: boolean;
  url?: string;
  secret?: string;
  events?: WebhookEventType[];
  createdAt?: string;
  updatedAt?: string;
}

export interface WebhookAckResponse {
  ok: boolean;
  message: string;
}

export interface DocumentCompletedWebhookEvent {
  id: string;
  type: 'document.completed';
  created_at: string;
  api_version: string;
  data: {
    id: string;
    status: 'COMPLETED' | 'completed';
    template_id?: string;
    file_url?: string;
    status_url?: string;
    file_size?: number;
    render_time_ms?: number;
    expires_at?: string;
    output_retention?: string;
  };
}

export interface DocumentFailedWebhookEvent {
  id: string;
  type: 'document.failed';
  created_at: string;
  api_version: string;
  data: {
    id: string;
    status: 'FAILED' | 'failed';
    template_id?: string;
    status_url?: string;
    error?: string;
  };
}

export interface BatchProgressWebhookEvent {
  id: string;
  type: 'batch.progress';
  created_at: string;
  api_version: string;
  data: {
    id: string;
    completed?: number;
    failed?: number;
    total?: number;
  };
}

export interface BatchCompletedWebhookEvent {
  id: string;
  type: 'batch.completed';
  created_at: string;
  api_version: string;
  data: {
    id: string;
    status?: string;
    completed?: number;
    failed?: number;
    total?: number;
    results?: Array<{
      index: number;
      status: string;
      fileUrl?: string;
      file_url?: string;
      error?: string;
    }>;
  };
}

export interface BatchFailedWebhookEvent {
  id: string;
  type: 'batch.failed';
  created_at: string;
  api_version: string;
  data: {
    id: string;
    error?: string;
  };
}

export interface WebhookTestEvent {
  id: string;
  type: 'webhook.test';
  created_at: string;
  api_version: string;
  data: {
    message: string;
  };
}

export type ShablonixWebhookEvent =
  | DocumentCompletedWebhookEvent
  | DocumentFailedWebhookEvent
  | BatchProgressWebhookEvent
  | BatchCompletedWebhookEvent
  | BatchFailedWebhookEvent
  | WebhookTestEvent;

export interface VerifyWebhookSignatureOptions {
  toleranceSeconds?: number;
  now?: Date;
}

export interface VerifiedWebhookMetadata {
  timestamp: number;
  event?: string;
  deliveryId?: string;
}
