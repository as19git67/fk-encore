# Event-Loop Back-Pressure and Health Check Prioritization

## Problem

When the server is under heavy load — for example when many scan workers are
continuously processing photos through external ML services — the Node.js
event loop can become saturated. Because Node.js is single-threaded, all
incoming HTTP requests (including health checks) share the same event loop with
background workers. Under sustained load the health check endpoints
(`/health`, `/healthz`, `/photos/service-health`) may not respond in time,
causing container orchestrators or the frontend to incorrectly report the
server as unhealthy.

Increasing timeout values does not fix the underlying problem: the health
check request simply cannot be processed because the event loop is busy
servicing worker callbacks.

## Solution

An event-loop back-pressure system automatically detects when the server is
overloaded and throttles background scan workers so that latency-sensitive
requests (health checks, UI queries) are served promptly.

### Components

#### 1. Event-Loop Pressure Monitor (`photo/event-loop-pressure.ts`)

A lightweight monitor that periodically measures event-loop lag:

1. It schedules a timer for `CHECK_INTERVAL_MS` (default: 2 000 ms).
2. When the timer fires it compares the actual elapsed time to the expected
   interval. The difference is the **lag**.
3. If the lag exceeds `LAG_THRESHOLD_MS` (default: 500 ms) the system is
   marked as **under pressure**.
4. When pressure is relieved (lag drops below the threshold) the flag is
   cleared and a log message is emitted.

The monitor exposes two functions consumed by the rest of the system:

- `isUnderPressure()` — returns `true` while the event loop is lagging.
- `getEventLoopLagMs()` — returns the most recently measured lag in
  milliseconds.

#### 2. Worker Throttling (`photo/scan-worker.ts`)

Scan workers respect the pressure state in two ways:

- **Yield between jobs:** After completing a job, a worker always yields to
  the event loop via `setTimeout()` before processing the next one. This
  ensures that pending I/O callbacks — such as incoming health check requests
  — get a chance to run between jobs, even under normal load.

- **Back off under pressure:** When `isUnderPressure()` returns `true`:
  - `processNext()` returns `false` immediately without dequeuing a job.
    The worker goes idle until the next periodic poll (every 30 s) or until
    `triggerWorkers()` is called.
  - If a job was just completed and there is more work, the worker waits
    `WORKER_PRESSURE_DELAY_MS` (default: 1 000 ms) before scheduling the
    next tick, giving the event loop significant breathing room.

Once pressure is relieved the workers resume at full speed automatically.

#### 3. Observability

The `/photos/service-health` API endpoint returns a `serverPressure` object
alongside the external-service statuses:

```json
{
  "services": [ ... ],
  "serverPressure": {
    "underPressure": false,
    "eventLoopLagMs": 42
  }
}
```

The state is exposed so operators can scrape it from logs / dashboards. The
frontend used to render a "Server ausgelastet" banner from this flag, but the
notice was repetitive and added little signal in the UI — it was removed in
favour of leaving the field as a pure server-side observability signal.

### Flow Diagram

```
                    ┌─────────────────────┐
                    │  Pressure Monitor   │
                    │  (2s interval)      │
                    └────────┬────────────┘
                             │
                   measures event-loop lag
                             │
               ┌─────────────┴─────────────┐
               │                           │
          lag <= 500ms               lag > 500ms
               │                           │
        isUnderPressure()           isUnderPressure()
          returns false               returns true
               │                           │
     ┌─────────┴─────────┐      ┌─────────┴─────────┐
     │  Workers run at   │      │  Workers pause /  │
     │  full speed       │      │  back off          │
     │  (yield between   │      │  (skip cycles,    │
     │   jobs via        │      │   1s delay when   │
     │   setTimeout(0))  │      │   resuming)       │
     └───────────────────┘      └───────────────────┘
```

## Configuration

All thresholds are configurable via environment variables:

| Variable | Default | Description |
|---|---|---|
| `EVENT_LOOP_CHECK_INTERVAL_MS` | `2000` | How often to measure event-loop lag (ms) |
| `EVENT_LOOP_LAG_THRESHOLD_MS` | `500` | Lag threshold that triggers back-pressure (ms) |
| `WORKER_PRESSURE_DELAY_MS` | `1000` | Delay between worker jobs when under pressure (ms) |

### Tuning Tips

- **Lower `EVENT_LOOP_LAG_THRESHOLD_MS`** (e.g. 200) for more aggressive
  throttling — workers will back off sooner, keeping health checks very
  responsive at the cost of slower background processing.
- **Raise `EVENT_LOOP_LAG_THRESHOLD_MS`** (e.g. 1000) if you have headroom
  and want workers to keep processing longer before backing off.
- **Increase `WORKER_PRESSURE_DELAY_MS`** (e.g. 2000–5000) on
  resource-constrained deployments to give the event loop more recovery time
  between jobs.
