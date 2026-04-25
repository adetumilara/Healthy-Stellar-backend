import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { trace, context } from '@opentelemetry/api';

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const request = ctx.switchToHttp().getRequest();
    const response = ctx.switchToHttp().getResponse();

    // Get current span and extract trace ID
    const span = trace.getSpan(context.active());
    const traceId = span?.spanContext().traceId;
    const spanId = span?.spanContext().spanId;

    // Add trace ID to request for logging
    if (traceId) {
      request.traceId = traceId;
      request.spanId = spanId;

      // Add trace ID to response headers
      response.setHeader('X-Trace-ID', traceId);
      response.setHeader('X-Span-ID', spanId);
    }

    // Add trace context to span attributes
    if (span) {
      span.setAttribute('http.method', request.method);
      span.setAttribute('http.url', request.url);
      span.setAttribute('http.target', request.path);
      span.setAttribute('http.host', request.hostname);
      span.setAttribute('http.scheme', request.protocol);

      // Add user info if available
      if ((request as any).user?.id) {
        span.setAttribute('user.id', (request as any).user.id);
      }

      // Add tenant info if available
      if (request.headers['x-tenant-id']) {
        span.setAttribute('tenant.id', request.headers['x-tenant-id']);
      }
    }

    return next.handle().pipe(
      tap(
        () => {
          // Success case
          if (span && response.statusCode) {
            span.setAttribute('http.status_code', response.statusCode);
          }

          // Ensure trace ID is in response even after processing
          if (traceId && !response.headersSent) {
            response.setHeader('X-Trace-ID', traceId);
            response.setHeader('X-Span-ID', spanId);
          }
        },
        (error) => {
          // Error case
          if (span) {
            span.setAttribute('http.status_code', response.statusCode || 500);
            span.recordException(error);
          }

          if (traceId && !response.headersSent) {
            response.setHeader('X-Trace-ID', traceId);
            response.setHeader('X-Span-ID', spanId);
          }
        },
      ),
    );
  }
}
