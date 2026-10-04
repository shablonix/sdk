import type {
  BatchGenerationResponse,
  GenerationResponse,
} from './types.js';

export class ShablonixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShablonixError';
  }
}

export class ShablonixApiError extends ShablonixError {
  readonly status: number;
  readonly body?: unknown;
  readonly traceId?: string;

  constructor(message: string, status: number, body?: unknown, traceId?: string) {
    super(message);
    this.name = 'ShablonixApiError';
    this.status = status;
    this.body = body;
    this.traceId = traceId;
  }
}

export class ShablonixTimeoutError extends ShablonixError {
  constructor(message = 'The Shablonix API request timed out') {
    super(message);
    this.name = 'ShablonixTimeoutError';
  }
}

export class ShablonixGenerationFailedError extends ShablonixError {
  readonly generation: GenerationResponse;

  constructor(generation: GenerationResponse) {
    super(generation.error || `Generation ${generation.id} failed`);
    this.name = 'ShablonixGenerationFailedError';
    this.generation = generation;
  }
}

export class ShablonixBatchFailedError extends ShablonixError {
  readonly batch: BatchGenerationResponse;

  constructor(batch: BatchGenerationResponse) {
    super(`Batch ${batch.id} failed`);
    this.name = 'ShablonixBatchFailedError';
    this.batch = batch;
  }
}
