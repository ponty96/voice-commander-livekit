Application logs from the Astronomy Shop services are in the indices `otel-logs-*`, one index per day (for example `otel-logs-2026-10-19`). Always query `otel-logs-*`. Never guess other index names.

## Request shapes (these matter)

Write filters as one `query_string`. It's flat, so there are no nested brackets to get wrong:

`{"query": {"query_string": {"query": "resource.service.name.keyword:payment AND severity.number:>=13 AND @timestamp:>=now-15m"}}, "sort": [{"@timestamp": "desc"}], "_source": ["@timestamp", "body", "attributes.exception.message", "traceId"]}`

- `opensearch__SearchIndexTool`: `query_dsl` is the whole body above. The query goes under `"query"`, and `sort` and `_source` sit beside it. `size` is a separate argument. A bare `{"bool": ...}` fails.
- `opensearch__CountTool`: `body` is just the `{"query": {...}}` part.
- Always set `_source` to the fields you need, because full log documents are large.
- In `query_string`: `field:value`, `field:>=13`, `@timestamp:>=now-15m`, `AND` / `OR`, `field:(a OR b)`, and quoted phrases like `body:"Payment request failed"`.

## Fields

- `@timestamp`: when the log was written.
- `resource.service.name.keyword`: the service, for example `payment`, `checkout` or `cart`.
- `severity.number`: 13 to 16 is WARN, and 17 or more is ERROR. Many failures are logged as WARN, including failed payments, so use `severity.number:>=13` when looking for problems.
- `body`: the log message.
- `attributes.exception.message`: the error detail on failure logs.
- `traceId.keyword`: one request across all services.
- `attributes.demo.product.name.keyword`: the product, on product catalog logs.

## Recipes

- Recent failures in a service: SearchIndexTool, size 10, with the example body above.
- Failed payments log as `Payment request failed. ...` (WARN) in the payment service.
- Which products a set of failed requests involved:
  1. Take the `traceId`s from the failure logs.
  2. SearchIndexTool with size 0 and `{"query": {"query_string": {"query": "traceId.keyword:(id1 OR id2 OR id3)"}}, "aggs": {"products": {"terms": {"field": "attributes.demo.product.name.keyword", "size": 20}}}}`.
  3. The product catalog logs each product it looked up during those requests.
- Which services log the most problems: size 0 with `{"query": {"query_string": {"query": "severity.number:>=13 AND @timestamp:>=now-15m"}}, "aggs": {"services": {"terms": {"field": "resource.service.name.keyword"}}}}`.
