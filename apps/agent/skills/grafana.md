Grafana here is the Astronomy Shop (OpenTelemetry demo) stack. Its datasources, by UID:

- `webstore-metrics`: Prometheus (metrics)
- `webstore-logs`: OpenSearch (logs). Query logs with the opensearch__ tools instead.
- `webstore-traces`: Jaeger (traces)

For metrics, call `grafana__query_prometheus` with `datasourceUid: "webstore-metrics"`. Don't guess metric names. These exist:

- Requests per second for each service, from trace span metrics:
  `sum by (service_name) (rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER"}[5m]))`
- Error rate for each service:
  `sum by (service_name) (rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER", status_code="STATUS_CODE_ERROR"}[5m]))`
- p95 latency in milliseconds for each service:
  `histogram_quantile(0.95, sum by (le, service_name) (rate(traces_span_metrics_duration_milliseconds_bucket{span_kind="SPAN_KIND_SERVER"}[5m])))`
- HTTP server request rate: `sum(rate(http_server_request_duration_seconds_count[5m]))`

Service names (`service_name` label) include frontend, frontend-proxy, checkout, cart, payment, product-catalog, recommendation, shipping, currency, ad, email, quote, accounting and fraud-detection.

To find other metrics, call `grafana__list_prometheus_metric_names` with a `regex` such as `.*request.*` or `.*checkout.*`. There are about 480 names, so an unfiltered list only shows the first few alphabetically.

Use instant queries for "right now" questions. For a trend, use a range query with `startTime: "now-15m"` and `endTime: "now"`.
