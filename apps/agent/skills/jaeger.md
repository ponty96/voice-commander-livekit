Traces show how one request moved through the services. Each trace is a tree of spans: one span per operation, children for the calls it made, with timing, errors and attributes.

## Start by discovering, don't guess

1. `list_trace_operations` with service null lists every service that sends traces.
2. `list_trace_operations` with a service lists its operations by span kind:
   - `server`: requests the service handles. These are its entry points.
   - `client`: calls it makes to other services. These are its dependencies.
   - `producer` and `consumer`: messages it publishes or receives.
   - `internal`: work done inside the service.
3. Then search, using the exact service and operation names you found.

## Searching

- `search_traces` needs a `service`. Narrow it with:
  - `operation`, for example the service's server operation;
  - `errorsOnly: true` for failures;
  - `minDurationMs` for slowness;
  - `attributes` for exact attribute matches.
- Start with `lookbackMinutes` 15 and `limit` 10. If nothing matches, widen the lookback before concluding there's nothing.
- The result starts with a tally of attribute values across all the traces, then summarizes each trace (services, errors, attributes). Use the tally for "which ones" and "how many" questions, such as which products, customers, currencies or amounts are affected.
- Attribute names come from the data. Read them from a first search, then filter on them with `attributes`. Don't invent attribute names.
- A search can return only part of a long trace. If something you expect is missing, call `get_trace` with that trace ID to see every span.

## Reading a trace

- The root span is where the request entered. A child span is a call made by its parent.
- An error usually starts in one span and then propagates up to every caller, often with the message wrapped again. The cause is the deepest failing span: the one with no failing child. Its service owns the problem. The callers are only affected.
- Compare a failing trace with a successful one for the same operation. The first span that differs is where to look.
- Duration: if a slow span's children account for its time, the slowness is downstream. If they don't, the time was spent in that service itself.
- Trace IDs also appear on log lines (`traceId` in OpenSearch). Use them to read the logs for one request, or to find traces starting from a log.
