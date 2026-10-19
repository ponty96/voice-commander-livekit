Application logs from the Astronomy Shop services are in the indices `otel-logs-*`, one index per day (for example `otel-logs-2026-10-19`). Always query `otel-logs-*` and never guess other index names.

Useful fields:

- `@timestamp` (date). Ranges need a format: `{"range": {"@timestamp": {"gte": "now-15m", "format": "strict_date_optional_time||epoch_millis"}}}`
- `resource.service.name` (text). Use `resource.service.name.keyword` for exact matches and aggregations, for example `{"term": {"resource.service.name.keyword": "checkout"}}`
- `severity.number` (number): 17 or more means ERROR or worse, and 13 to 16 means WARN. This is more reliable than the text level.
- `severity.text` (text). Its casing varies between services (INFO, info, Information, ERROR, error).
- `body` (text): the log message.
- `traceId` and `spanId`: they link a log line to a trace.

Examples:

- Count checkout errors in the last hour: `opensearch__CountTool` with index `otel-logs-*` and body `{"query": {"bool": {"filter": [{"term": {"resource.service.name.keyword": "checkout"}}, {"range": {"severity.number": {"gte": 17}}}, {"range": {"@timestamp": {"gte": "now-1h", "format": "strict_date_optional_time||epoch_millis"}}}]}}}`
- Latest error messages: `opensearch__SearchIndexTool` on `otel-logs-*` with the same filter, `"size": 10` and `"sort": [{"@timestamp": "desc"}]`.
- Which services log the most errors: a terms aggregation on `resource.service.name.keyword` with `"size": 0`.
