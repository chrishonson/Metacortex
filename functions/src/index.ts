import { onRequest } from "firebase-functions/v2/https";

import { createOpenBrainApp } from "./app.js";
import { getConfig, getRuntime } from "./runtime.js";

export const openBrainMcp = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB"
  },
  createOpenBrainApp({
    getAuthToken: () => getConfig().authToken,
    getRuntime
  })
);
