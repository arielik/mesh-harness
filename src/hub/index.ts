// mesh hub: HTTP API, auth routes, SSE hint channel (plan §8).
export { createApp, type Route } from "./app.ts";
export { ChannelHintBus, LocalHintBus, type Hint, type HintBus } from "./bus.ts";
export { buildHubConfig, HubConfigFile, isLoopback, loadHubConfig, parseDuration, type HubConfig } from "./config.ts";
export { HubError, HubService, type Actor } from "./service.ts";
export { startHub, type RunningHub } from "./server.ts";
