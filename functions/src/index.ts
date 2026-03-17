import { onRequest } from "firebase-functions/v2/https";

import { createOpenBrainApp } from "./app.js";
import { getConfig, getObserver, getRuntime } from "./runtime.js";

export const metaCortexMcp = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
    invoker: "public"
  },
  createOpenBrainApp({
    getConfig,
    getObserver,
    getRuntime
  })
);
