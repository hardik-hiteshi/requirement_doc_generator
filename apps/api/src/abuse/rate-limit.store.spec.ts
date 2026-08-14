import { rateLimitKey, type RateLimitPolicy } from '@wdrg/contracts';

import type { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';
import { RateLimitStore } from './rate-limit.store';

/**
 * The counter, checked at its edges.
 *
 * A limiter is only useful if it refuses at exactly the right request, releases at
 * exactly the right moment, and cannot be made to grow without bound. Each of those
 * is an off-by-one away from either locking out real users or protecting nothing.
 */

const policy: RateLimitPolicy = { limit: 3, windowSeconds: 60 };

function store(maxKeys = 1_000): RateLimitStore {
  const config = { rateLimit: { maxKeys } } as unknown as AppConfigService;

  return new RateLimitStore(config, new MetricsService());
}

describe('the rate-limit store', () => {
  it('allows exactly the budget and refuses the request after it', () => {
    const subject = store();
    const outcomes: boolean[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      outcomes.push(subject.consume('k', policy, 1_000).allowed);
    }

    expect(outcomes).toEqual([true, true, true, false]);
  });

  it('reports what is left, and never a negative', () => {
    const subject = store();

    expect(subject.consume('k', policy, 1_000).remaining).toBe(2);
    expect(subject.consume('k', policy, 1_000).remaining).toBe(1);
    expect(subject.consume('k', policy, 1_000).remaining).toBe(0);
    expect(subject.consume('k', policy, 1_000).remaining).toBe(0);
  });

  it('releases the budget once the window has passed', () => {
    const subject = store();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      subject.consume('k', policy, 1_000);
    }

    expect(subject.consume('k', policy, 1_000).allowed).toBe(false);
    /* One millisecond past the window's end. */
    expect(subject.consume('k', policy, 61_001).allowed).toBe(true);
  });

  it('does not extend the window when a refused caller keeps trying', () => {
    const subject = store();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      subject.consume('k', policy, 1_000 + attempt);
    }

    /*
     * The window still ends when it was always going to. A limiter that slid the
     * window forward on every refusal could lock somebody out indefinitely because
     * of a retry loop they cannot see.
     */
    expect(subject.consume('k', policy, 61_001).allowed).toBe(true);
  });

  it('reports how long to wait, rounded up and never zero', () => {
    const subject = store();

    const decision = subject.consume('k', policy, 1_000);

    expect(decision.retryAfterSeconds).toBe(60);

    /* Almost expired: still at least a second, because "retry after 0" is nonsense. */
    expect(subject.consume('k', policy, 60_900).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('keeps separate budgets for separate keys', () => {
    const subject = store();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      subject.consume('a', policy, 1_000);
    }

    expect(subject.consume('a', policy, 1_000).allowed).toBe(false);
    expect(subject.consume('b', policy, 1_000).allowed).toBe(true);
  });

  it('keeps one class from spending another class of the same caller', () => {
    const subject = store();
    const exportKey = rateLimitKey({ rateClass: 'export', sessionId: 'p1', address: '::1' });
    const readKey = rateLimitKey({ rateClass: 'default', sessionId: 'p1', address: '::1' });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      subject.consume(exportKey, policy, 1_000);
    }

    expect(subject.consume(exportKey, policy, 1_000).allowed).toBe(false);
    expect(subject.consume(readKey, policy, 1_000).allowed).toBe(true);
  });

  it('stays bounded when a flood arrives from many addresses', () => {
    const subject = store(50);

    for (let index = 0; index < 500; index += 1) {
      subject.consume(`key-${index}`, policy, 1_000);
    }

    /*
     * The bound is what matters, not the exact size: without it a flood would grow
     * the map until the process died, which is the outage the limiter exists to stop.
     */
    expect(subject.size()).toBeLessThanOrEqual(50);
  });

  it('drops expired windows before live ones when it has to evict', () => {
    /*
     * Capacity four, three keys held, so the fourth request is the one that has to
     * make room. A tighter cap would evict again on the assertion below and prove
     * nothing about which key was chosen.
     */
    const subject = store(4);
    const longWindow = { limit: 3, windowSeconds: 3_600 };

    subject.consume('old', policy, 1_000);
    subject.consume('fresh-a', longWindow, 1_000);
    subject.consume('fresh-b', longWindow, 1_000);
    subject.consume('new', longWindow, 1_000);

    /* Past `old`'s window: it holds no information, and is the right thing to lose. */
    const decision = subject.consume('fresh-a', longWindow, 61_002);

    expect(subject.size()).toBeLessThanOrEqual(4);
    /* The live budget survived with its count intact — this is its second request. */
    expect(decision.remaining).toBe(1);
  });
});

describe('rate-limit keys', () => {
  it('keys the credential-guessing class by address, not by session', () => {
    const first = rateLimitKey({ rateClass: 'access', sessionId: 'p1', address: '10.0.0.1' });
    const second = rateLimitKey({ rateClass: 'access', sessionId: 'p2', address: '10.0.0.1' });

    /* Same attacker, two claimed sessions, one budget. */
    expect(first).toBe(second);
  });

  it('keys everything else by session, so one project cannot spend another', () => {
    const first = rateLimitKey({ rateClass: 'export', sessionId: 'p1', address: '10.0.0.1' });
    const second = rateLimitKey({ rateClass: 'export', sessionId: 'p2', address: '10.0.0.1' });

    expect(first).not.toBe(second);
  });

  it('falls back to the address when there is no session', () => {
    expect(rateLimitKey({ rateClass: 'default', sessionId: undefined, address: '10.0.0.9' })).toBe(
      'default|ip:10.0.0.9',
    );
  });
});
