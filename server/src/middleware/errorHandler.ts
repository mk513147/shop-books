import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { AppError, NotFoundError } from '../utils/errors.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string | undefined;
    details?: { path: string; message: string }[];
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route not found: ${req.method} ${req.path}`));
};

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  type?: string;
}

function isHttpLike(err: unknown): err is HttpLikeError {
  return typeof err === 'object' && err !== null && ('status' in err || 'statusCode' in err);
}

/**
 * Converts every error into one consistent JSON shape. Internal error details and stack traces
 * are logged server-side only and never sent to the client.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const requestId = res.locals.requestId as string | undefined;
    let status = 500;
    let body: ErrorBody = {
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    };

    if (err instanceof AppError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, requestId } };
      if (err.details) body.error.details = err.details;
    } else if (err instanceof ZodError) {
      status = 400;
      body = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          requestId,
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      };
    } else if (isHttpLike(err)) {
      // Errors raised by Express / body-parser (malformed JSON, payload too large, ...).
      const httpStatus = err.status ?? err.statusCode ?? 500;
      if (httpStatus >= 400 && httpStatus < 500) {
        status = httpStatus;
        if (err.type === 'entity.too.large') {
          body = { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', requestId } };
        } else if (err.type === 'entity.parse.failed') {
          body = { error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON', requestId } };
        } else {
          body = { error: { code: 'BAD_REQUEST', message: 'The request could not be processed', requestId } };
        }
      }
    }

    if (status >= 500) logger.error({ err, requestId }, 'Unhandled request error');
    else logger.debug({ code: body.error.code, requestId }, 'Request rejected');

    res.status(status).json(body);
  };
}
