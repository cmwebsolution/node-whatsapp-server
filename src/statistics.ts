const bounds = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
];
/** Fixed-memory histograms. Quantiles are bucket upper bounds, not exact samples. */
export class Histogram {
  private counts = Array.from({ length: bounds.length + 1 }, () => 0);
  private total = 0;
  private sum = 0;
  private max = 0;
  observe(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const index = bounds.findIndex((b) => ms <= b);
    this.counts[index < 0 ? bounds.length : index]++;
    this.total++;
    this.sum += ms;
    this.max = Math.max(this.max, ms);
  }
  snapshot() {
    const percentile = (p: number) => {
      if (!this.total) return 0;
      let n = 0;
      for (let i = 0; i < this.counts.length; i++) {
        n += this.counts[i];
        if (n >= Math.ceil(this.total * p))
          return bounds[i] ?? Math.ceil(this.max);
      }
      return Math.ceil(this.max);
    };
    return {
      count: this.total,
      mean_ms: this.total ? Math.round(this.sum / this.total) : 0,
      max_ms: Math.ceil(this.max),
      p50_ms: percentile(0.5),
      p95_ms: percentile(0.95),
      p99_ms: percentile(0.99),
      quantiles: "bucket_upper_bound",
    };
  }
}
