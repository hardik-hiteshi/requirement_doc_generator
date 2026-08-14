import { Injectable } from '@nestjs/common';
import { METRIC_NAMES, renderMetrics, type MetricName, type MetricSample } from '@wdrg/contracts';

/**
 * Counters and gauges, held in this process.
 *
 * No client library and no agent. A metric here is a number in a map, and the only
 * consumer is a scrape endpoint that renders them as text — which is all a
 * self-hosted collector needs, and avoids adding a dependency whose own release
 * cadence would then have to be tracked.
 *
 * ## Process-local, and honest about it
 *
 * These reset when the process restarts, and behind several instances each reports
 * its own. That is normal for counters: a collector computes rates across restarts
 * from the reset, and sums across instances. What it means for the operator surface
 * is that `refusals` describes this instance since it started, and the status
 * response says so.
 *
 * ## Bounded label cardinality
 *
 * Labels come from closed sets — a rate-limit class, an export format, an outcome —
 * never from a path, a project id or anything a caller controls. Unbounded labels
 * are how a metrics endpoint becomes a memory leak.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly startedAt = Date.now();

  increment(name: MetricName, labels: Readonly<Record<string, string>> = {}, by = 1): void {
    const key = this.key(name, labels);

    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  setGauge(name: MetricName, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.gauges.set(this.key(name, labels), value);
  }

  /** A counter's current value. For the operator surface and for tests. */
  read(name: MetricName, labels: Readonly<Record<string, string>> = {}): number {
    const key = this.key(name, labels);

    return this.counters.get(key) ?? this.gauges.get(key) ?? 0;
  }

  /** Every value for one metric, keyed by its first label value. */
  readByLabel(name: MetricName, label: string): Readonly<Record<string, number>> {
    const result: Record<string, number> = {};

    for (const [key, value] of this.counters) {
      const parsed = this.parse(key);

      if (parsed.name === name && parsed.labels[label] !== undefined) {
        result[parsed.labels[label]] = value;
      }
    }

    return result;
  }

  /** The exposition text a collector scrapes. */
  render(): string {
    this.setGauge(
      METRIC_NAMES.processUptimeSeconds,
      Math.floor((Date.now() - this.startedAt) / 1000),
    );

    const samples: MetricSample[] = [];

    for (const [key, value] of [...this.counters, ...this.gauges]) {
      const parsed = this.parse(key);

      samples.push({ name: parsed.name, labels: parsed.labels, value });
    }

    /* Stable order, so a diff between two scrapes is readable by a person. */
    samples.sort((left, right) =>
      left.name === right.name
        ? JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels))
        : left.name.localeCompare(right.name),
    );

    return renderMetrics(samples);
  }

  /** For tests, which must not inherit counts from one another. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }

  private key(name: MetricName, labels: Readonly<Record<string, string>>): string {
    const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));

    return JSON.stringify([name, entries]);
  }

  private parse(key: string): { name: MetricName; labels: Record<string, string> } {
    const [name, entries] = JSON.parse(key) as [MetricName, [string, string][]];

    return { name, labels: Object.fromEntries(entries) };
  }
}
