# ADR 0001: Provider-owned video capture

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Pose, the app hand adapter and `SpatialRuntime` each scheduled video frames and enforced backpressure. The copies differed in scheduling/session state, so fixes to timestamp monotonicity, fallback scheduling or single-flight behavior could drift. `SpatialRuntime` is exported and tested even though no production caller was found, and injected clients that only implement `processFrame` are an existing contract.

## Decision

Keep one internal `VideoFramePump` beside the worker providers. It owns rVFC/rAF scheduling, unchanged-video-time suppression for the rAF fallback, monotonically increasing timestamps and one asynchronous frame flight. It does not create or retain `ImageBitmap` objects.

`PoseClient` and `HandClient` own their live capture and keep worker protocols, resizing and bitmap transfer/close rules with their task-specific provider. `SpatialRuntime` delegates live capture to providers that expose `beginCapture`; processFrame-only injected adapters continue to work through the same pump. Preserve `HandClient.processFrame` and worker request/epoch correlation.

The in-flight slot remains occupied across pause/restart until the outstanding provider operation settles. Stopping cancels scheduled callbacks and invalidates their generation; it cannot cancel an already running bitmap copy or worker request. A disposed provider settles its pending frame so the pump can release backpressure.

## Consequences

- Temporal rules have one implementation, with deterministic tests for both rVFC and rAF, errors, restart and stale callbacks.
- Existing processFrame-only `SpatialRuntime` adapters remain compatible while production hand capture no longer has a separate app-layer loop.
- Pose capture now waits for its correlated worker reply/error before allowing the pump to submit another frame. Request IDs and capture epochs still reject stale worker messages.
- The pump is browser-facing infrastructure, not a headless CV primitive; it stays internal and is not exported from the package barrel.
- A permanently unresolved provider operation will hold the pump's single-flight slot. Providers in this package settle their pending frame on reply or disposal; future adapters must keep the same progress contract.
