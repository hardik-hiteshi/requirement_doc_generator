import { CORRELATION_ID_HEADER } from '@wdrg/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createRequestIdFactory, resolveCorrelationId } from './correlation-id';

function request(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it('adopts a valid x-request-id from the caller', () => {
    expect(resolveCorrelationId(request({ 'x-request-id': 'gateway-abc-123' }))).toBe(
      'gateway-abc-123',
    );
  });

  it('falls back to x-correlation-id', () => {
    expect(resolveCorrelationId(request({ 'x-correlation-id': 'client-xyz' }))).toBe('client-xyz');
  });

  it('prefers x-request-id when both are present', () => {
    const id = resolveCorrelationId(
      request({ 'x-request-id': 'from-gateway', 'x-correlation-id': 'from-client' }),
    );
    expect(id).toBe('from-gateway');
  });

  it('generates a uuid when no header is supplied', () => {
    expect(resolveCorrelationId(request({}))).toMatch(UUID_PATTERN);
  });

  it('rejects a log-injection attempt and generates a fresh id instead', () => {
    const id = resolveCorrelationId(request({ 'x-request-id': 'abc\n{"level":50,"msg":"fake"}' }));

    expect(id).not.toContain('\n');
    expect(id).toMatch(UUID_PATTERN);
  });

  it('rejects an over-long header value', () => {
    const id = resolveCorrelationId(request({ 'x-request-id': 'a'.repeat(500) }));
    expect(id).toMatch(UUID_PATTERN);
  });

  it('uses the first value of a repeated header', () => {
    expect(resolveCorrelationId(request({ 'x-request-id': ['first-id', 'second-id'] }))).toBe(
      'first-id',
    );
  });

  it('generates a distinct id per request', () => {
    expect(resolveCorrelationId(request({}))).not.toBe(resolveCorrelationId(request({})));
  });
});

describe('createRequestIdFactory', () => {
  it('echoes the correlation id on the response', () => {
    const setHeader = jest.fn();
    const genReqId = createRequestIdFactory();

    const id = genReqId(request({ 'x-request-id': 'trace-me' }), {
      setHeader,
    } as unknown as ServerResponse);

    expect(id).toBe('trace-me');
    expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'trace-me');
  });

  it('echoes a generated id when the caller supplied none', () => {
    const setHeader = jest.fn();
    const id = createRequestIdFactory()(request({}), { setHeader } as unknown as ServerResponse);

    expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, id);
  });
});
