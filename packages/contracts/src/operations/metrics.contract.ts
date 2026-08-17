/**
 * Application metrics, in the one format every self-hosted collector reads.
 *
 * Prometheus' exposition format is plain text: a name, optional labels, a number.
 * Emitting it directly means no client library, no agent, no sidecar and no
 * account — a scrape endpoint and whatever the operator already runs. A hosted
 * monitoring vendor would give dashboards for a subscription; this gives the same
 * numbers to something the operator owns.
 *
 * ## Counters only, and few of them
 *
 * Every metric here is a monotonic counter or an instantaneous gauge, and each one
 * answers a question an operator actually asks: is anything being refused, is the
 * retention job running, are exports failing. Histograms and per-route timing are
 * absent deliberately — they multiply series by route and status, and nothing in
 * this deployment consumes them yet.
 *
 * ## No labels that identify a project
 *
 * A metric is retained far longer than an audit event and is often visible more
 * widely, so nothing here is labelled by project or session. Class and outcome
 * only.
 */

export const METRIC_NAMES = {
  requestsTotal: 'wdrg_http_requests_total',
  requestDurationSeconds: 'wdrg_http_request_duration_seconds',
  errorsTotal: 'wdrg_errors_total',
  rateLimitRefusalsTotal: 'wdrg_rate_limit_refusals_total',
  rateLimitTrackedKeys: 'wdrg_rate_limit_tracked_keys',
  retentionSweepsTotal: 'wdrg_retention_sweeps_total',
  retentionProjectsPurgedTotal: 'wdrg_retention_projects_purged_total',
  retentionRecordsRemovedTotal: 'wdrg_retention_records_removed_total',
  retentionFailuresTotal: 'wdrg_retention_failures_total',
  exportsTotal: 'wdrg_exports_total',
  adminDeniedTotal: 'wdrg_admin_denied_total',
  processUptimeSeconds: 'wdrg_process_uptime_seconds',
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

export const METRIC_HELP: Readonly<Record<MetricName, string>> = {
  [METRIC_NAMES.requestsTotal]: 'HTTP requests handled, by outcome class.',
  [METRIC_NAMES.requestDurationSeconds]: 'Request duration in seconds, by outcome class.',
  [METRIC_NAMES.errorsTotal]: 'Requests that failed, by error code.',
  [METRIC_NAMES.rateLimitRefusalsTotal]: 'Requests refused by a rate ceiling, by class.',
  [METRIC_NAMES.rateLimitTrackedKeys]: 'Rate-limit counter keys currently held in memory.',
  [METRIC_NAMES.retentionSweepsTotal]: 'Retention sweeps completed, by outcome.',
  [METRIC_NAMES.retentionProjectsPurgedTotal]: 'Projects whose content has been purged.',
  [METRIC_NAMES.retentionRecordsRemovedTotal]: 'Documents removed by retention purges.',
  [METRIC_NAMES.retentionFailuresTotal]: 'Projects a retention sweep could not complete.',
  [METRIC_NAMES.exportsTotal]: 'Document exports produced, by format.',
  [METRIC_NAMES.adminDeniedTotal]: 'Operator requests refused.',
  [METRIC_NAMES.processUptimeSeconds]: 'Seconds since this process started.',
};

export const METRIC_TYPES: Readonly<Record<MetricName, 'counter' | 'gauge' | 'histogram'>> = {
  [METRIC_NAMES.requestsTotal]: 'counter',
  [METRIC_NAMES.requestDurationSeconds]: 'histogram',
  [METRIC_NAMES.errorsTotal]: 'counter',
  [METRIC_NAMES.rateLimitRefusalsTotal]: 'counter',
  [METRIC_NAMES.rateLimitTrackedKeys]: 'gauge',
  [METRIC_NAMES.retentionSweepsTotal]: 'counter',
  [METRIC_NAMES.retentionProjectsPurgedTotal]: 'counter',
  [METRIC_NAMES.retentionRecordsRemovedTotal]: 'counter',
  [METRIC_NAMES.retentionFailuresTotal]: 'counter',
  [METRIC_NAMES.exportsTotal]: 'counter',
  [METRIC_NAMES.adminDeniedTotal]: 'counter',
  [METRIC_NAMES.processUptimeSeconds]: 'gauge',
};

/**
 * Latency buckets, in seconds.
 *
 * Seven boundaries covering the range that tells an operator something: a request
 * under 50ms is a read, one over five seconds is a model run or a large render, and
 * the interesting movement is in between. More boundaries would multiply series for
 * resolution nobody acts on.
 *
 * Labelled by **outcome class only** — never by route. A per-route histogram is
 * seven buckets times a hundred and thirty routes times every status, which is how a
 * metrics endpoint becomes the memory problem it was added to detect.
 */
export const LATENCY_BUCKETS_SECONDS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 1, 5, 10];

/**
 * How a request is classified for metrics.
 *
 * Status *classes*, not codes: a counter per code turns a scan of 4xx noise into
 * dozens of series that say the same thing. `refused` is separated from other client
 * errors because "somebody is hitting a ceiling" is operationally different from
 * "somebody sent a bad payload".
 */
export const OUTCOME_CLASSES = ['ok', 'client_error', 'refused', 'server_error'] as const;

export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

export function outcomeClass(status: number): OutcomeClass {
  if (status === 429) {
    return 'refused';
  }

  if (status >= 500) {
    return 'server_error';
  }

  return status >= 400 ? 'client_error' : 'ok';
}

export interface MetricSample {
  readonly name: MetricName;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** A label value, with the characters the format treats specially escaped. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Renders samples as Prometheus exposition text.
 *
 * `# HELP` and `# TYPE` are emitted once per metric name, before its samples, which
 * is what the format requires — a collector rejects a repeated `TYPE` line.
 */
export interface HistogramSample {
  readonly name: MetricName;
  readonly labels: Readonly<Record<string, string>>;
  /** Cumulative counts, one per boundary in `LATENCY_BUCKETS_SECONDS`. */
  readonly buckets: readonly number[];
  readonly sum: number;
  readonly count: number;
}

/**
 * Renders histograms in the three series the format defines.
 *
 * `_bucket` counts are **cumulative** — each includes everything below it — and the
 * final `+Inf` bucket must equal `_count`, or a collector reports the series as
 * malformed rather than ignoring it.
 *
 * Grouped by name, and `HELP`/`TYPE` emitted once per name rather than once per label
 * set. Rendering each series independently produced a second `TYPE` line as soon as a
 * metric had two label values, and a repeated `TYPE` makes a collector reject the
 * entire scrape — so one malformed histogram would have taken every other metric with
 * it.
 */
export function renderHistograms(histograms: readonly HistogramSample[]): string {
  const byName = new Map<MetricName, HistogramSample[]>();

  for (const histogram of histograms) {
    const existing = byName.get(histogram.name);

    if (existing) {
      existing.push(histogram);
    } else {
      byName.set(histogram.name, [histogram]);
    }
  }

  const lines: string[] = [];

  for (const [name, group] of byName) {
    lines.push(`# HELP ${name} ${METRIC_HELP[name]}`);
    lines.push(`# TYPE ${name} histogram`);

    for (const histogram of group) {
      const label = (extra: Record<string, string>): string => {
        const entries = Object.entries({ ...histogram.labels, ...extra });

        return entries.length > 0
          ? `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`
          : '';
      };

      let cumulative = 0;

      LATENCY_BUCKETS_SECONDS.forEach((boundary, index) => {
        cumulative += histogram.buckets[index] ?? 0;
        lines.push(`${name}_bucket${label({ le: String(boundary) })} ${cumulative}`);
      });

      lines.push(`${name}_bucket${label({ le: '+Inf' })} ${histogram.count}`);
      lines.push(`${name}_sum${label({})} ${histogram.sum}`);
      lines.push(`${name}_count${label({})} ${histogram.count}`);
    }
  }

  return lines.join('\n');
}

export function renderMetrics(samples: readonly MetricSample[]): string {
  const byName = new Map<MetricName, MetricSample[]>();

  for (const sample of samples) {
    const existing = byName.get(sample.name);

    if (existing) {
      existing.push(sample);
    } else {
      byName.set(sample.name, [sample]);
    }
  }

  const lines: string[] = [];

  for (const [name, group] of byName) {
    lines.push(`# HELP ${name} ${METRIC_HELP[name]}`);
    lines.push(`# TYPE ${name} ${METRIC_TYPES[name]}`);

    for (const sample of group) {
      const labels = Object.entries(sample.labels)
        .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
        .join(',');

      lines.push(
        labels.length > 0 ? `${name}{${labels}} ${sample.value}` : `${name} ${sample.value}`,
      );
    }
  }

  /* A trailing newline: some collectors discard a final line without one. */
  return `${lines.join('\n')}\n`;
}
