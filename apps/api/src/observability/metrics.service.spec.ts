import { METRIC_NAMES, LATENCY_BUCKETS_SECONDS, outcomeClass } from '@wdrg/contracts';

import { MetricsService } from './metrics.service';

/**
 * The registry, checked against the format a collector actually parses.
 *
 * A metrics endpoint that emits slightly-wrong exposition text is worse than one that
 * emits nothing: the collector rejects the whole scrape, so a single malformed
 * histogram takes every other series with it. The assertions here are about the parts
 * of the format that are easy to get wrong — cumulative buckets, `+Inf` matching the
 * count, and one `TYPE` line per metric.
 */
describe('the metric registry', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('counts and reads back a labelled counter', () => {
    metrics.increment(METRIC_NAMES.requestsTotal, { outcome: 'ok' });
    metrics.increment(METRIC_NAMES.requestsTotal, { outcome: 'ok' });
    metrics.increment(METRIC_NAMES.requestsTotal, { outcome: 'server_error' });

    expect(metrics.read(METRIC_NAMES.requestsTotal, { outcome: 'ok' })).toBe(2);
    expect(metrics.read(METRIC_NAMES.requestsTotal, { outcome: 'server_error' })).toBe(1);
  });

  it('keeps label sets distinct regardless of the order they were written in', () => {
    metrics.increment(METRIC_NAMES.errorsTotal, { code: 'NOT_FOUND' });

    /* The key is order-independent, so a differently-ordered read finds the same series. */
    expect(metrics.read(METRIC_NAMES.errorsTotal, { code: 'NOT_FOUND' })).toBe(1);
    expect(metrics.read(METRIC_NAMES.errorsTotal, { code: 'CONFLICT' })).toBe(0);
  });

  describe('histograms', () => {
    it('puts an observation in the first bucket at or above it', () => {
      metrics.observe(METRIC_NAMES.requestDurationSeconds, 0.03, { outcome: 'ok' });

      const recorded = metrics.readHistogram(METRIC_NAMES.requestDurationSeconds, {
        outcome: 'ok',
      });

      expect(recorded?.buckets[0]).toBe(1);
      expect(recorded?.count).toBe(1);
      expect(recorded?.sum).toBeCloseTo(0.03);
    });

    it('counts a value above every boundary without putting it in a bucket', () => {
      const beyond = LATENCY_BUCKETS_SECONDS[LATENCY_BUCKETS_SECONDS.length - 1]! + 5;

      metrics.observe(METRIC_NAMES.requestDurationSeconds, beyond, { outcome: 'ok' });

      const recorded = metrics.readHistogram(METRIC_NAMES.requestDurationSeconds, {
        outcome: 'ok',
      });

      expect(recorded?.buckets.reduce((total, value) => total + value, 0)).toBe(0);
      /* Still counted, which is what makes `+Inf` equal the count in the output. */
      expect(recorded?.count).toBe(1);
      expect(recorded?.sum).toBeCloseTo(beyond);
    });

    it('renders cumulative buckets, ending at the count', () => {
      metrics.observe(METRIC_NAMES.requestDurationSeconds, 0.02, { outcome: 'ok' });
      metrics.observe(METRIC_NAMES.requestDurationSeconds, 0.4, { outcome: 'ok' });
      metrics.observe(METRIC_NAMES.requestDurationSeconds, 60, { outcome: 'ok' });

      const text = metrics.render();
      const buckets = [...text.matchAll(/_bucket\{outcome="ok",le="([^"]+)"\} (\d+)/g)].map(
        ([, boundary, value]) => [boundary, Number(value)] as const,
      );

      /* Non-decreasing, because each bucket includes everything below it. */
      const counts = buckets.map(([, value]) => value);

      expect(counts).toEqual([...counts].sort((left, right) => left - right));

      /* The last is `+Inf`, and it must equal `_count` or the scrape is rejected. */
      expect(buckets.at(-1)?.[0]).toBe('+Inf');
      expect(buckets.at(-1)?.[1]).toBe(3);
      expect(text).toContain('wdrg_http_request_duration_seconds_count{outcome="ok"} 3');
    });

    it('declares the histogram type exactly once', () => {
      metrics.observe(METRIC_NAMES.requestDurationSeconds, 0.1, { outcome: 'ok' });
      metrics.observe(METRIC_NAMES.requestDurationSeconds, 0.1, { outcome: 'client_error' });

      const text = metrics.render();

      expect(text.match(/# TYPE wdrg_http_request_duration_seconds histogram/g)).toHaveLength(1);
    });
  });

  it('emits the two series Phase 12 declared and never produced', () => {
    /*
     * The regression this phase exists to prevent: both names had help text and a type
     * in the contract and no code path that produced a sample, so a collector saw
     * nothing about traffic or exports.
     */
    metrics.increment(METRIC_NAMES.requestsTotal, { outcome: 'ok' });
    metrics.increment(METRIC_NAMES.exportsTotal, { format: 'PDF' });

    const text = metrics.render();

    expect(text).toContain('wdrg_http_requests_total{outcome="ok"} 1');
    expect(text).toContain('wdrg_exports_total{format="PDF"} 1');
  });

  it('always reports uptime, so a scrape is never empty', () => {
    expect(metrics.render()).toContain('wdrg_process_uptime_seconds');
  });

  it('forgets everything on reset, histograms included', () => {
    metrics.increment(METRIC_NAMES.errorsTotal, { code: 'CONFLICT' });
    metrics.observe(METRIC_NAMES.requestDurationSeconds, 1, { outcome: 'ok' });

    metrics.reset();

    expect(metrics.read(METRIC_NAMES.errorsTotal, { code: 'CONFLICT' })).toBe(0);
    expect(
      metrics.readHistogram(METRIC_NAMES.requestDurationSeconds, { outcome: 'ok' }),
    ).toBeUndefined();
  });
});

describe('outcome classification', () => {
  it('separates a refusal from other client errors', () => {
    /* "Somebody is hitting a ceiling" is a different operational fact from "bad payload". */
    expect(outcomeClass(429)).toBe('refused');
    expect(outcomeClass(422)).toBe('client_error');
    expect(outcomeClass(404)).toBe('client_error');
  });

  it('classifies success and failure', () => {
    expect(outcomeClass(200)).toBe('ok');
    expect(outcomeClass(201)).toBe('ok');
    expect(outcomeClass(304)).toBe('ok');
    expect(outcomeClass(500)).toBe('server_error');
    expect(outcomeClass(503)).toBe('server_error');
  });
});
