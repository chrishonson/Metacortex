import { randomUUID, timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type Request, type Response } from "express";

import { type AppConfig, type ClientProfile, MissingConfigurationError } from "./config.js";
import { HttpError } from "./errors.js";
import { createOpenBrainMcpServer } from "./mcpServer.js";
import type { ToolCallObserver } from "./observability.js";
import { type RuntimeDependencies } from "./runtime.js";

interface ActiveSession {
  transport: SSEServerTransport;
}

export interface CreateAppOptions {
  getConfig: () => AppConfig;
  getObserver: () => ToolCallObserver;
  getRuntime: () => RuntimeDependencies;
}

export function createOpenBrainApp(options: CreateAppOptions) {
  const app = express();
  const sessions = new Map<string, ActiveSession>();

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "metacortex",
      endpoints: ["/mcp", "/mcp/sse", "/mcp/messages", "/clients/:clientId/mcp"]
    });
  });

  registerMcpRoutes(
    app,
    sessions,
    "/mcp",
    "/mcp/messages",
    options,
    (_req, config) => config.defaultClientProfile
  );
  registerMcpRoutes(
    app,
    sessions,
    "/clients/:clientId/mcp",
    "/clients/:clientId/mcp/messages",
    options,
    (req, config) =>
      config.clientProfiles.find(profile => profile.id === req.params.clientId)
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

function registerMcpRoutes(
  app: express.Express,
  sessions: Map<string, ActiveSession>,
  mountPath: string,
  messagesPath: string,
  options: CreateAppOptions,
  resolveProfile: (req: Request, config: AppConfig) => ClientProfile | undefined
): void {
  const router = express.Router({ mergeParams: true });

  router.use((req, res, next) => {
    const startedAt = Date.now();
    res.locals.requestStartedAt = startedAt;
    let config: AppConfig;

    try {
      config = options.getConfig();
    } catch (error) {
      handleAppError(req, res, error);
      return;
    }

    const profile = resolveProfile(req, config);

    if (!profile) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (!applyCorsHeaders(req, res, profile)) {
      void recordRequestEvent(
        options,
        profile.id,
        req,
        "rejected",
        403,
        "origin_not_allowed",
        startedAt
      );
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    if (!isAuthorized(req, profile.authToken)) {
      void recordRequestEvent(
        options,
        profile.id,
        req,
        "rejected",
        401,
        "unauthorized",
        startedAt
      );
      res.setHeader("WWW-Authenticate", 'Bearer realm="firebase-open-brain"');
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      res.locals.runtime = options.getRuntime();
      res.locals.clientProfile = profile;
      next();
    } catch (error) {
      handleAppError(req, res, error);
    }
  });

  router.get("/sse", async (req, res) => {
    const runtime = res.locals.runtime as RuntimeDependencies;
    const profile = res.locals.clientProfile as ClientProfile;

    if (sessions.size >= runtime.config.maxSseSessions) {
      void recordRequestEvent(
        options,
        profile.id,
        req,
        "degraded",
        503,
        "sse_capacity_exceeded",
        res.locals.requestStartedAt as number | undefined
      );
      res.status(503).json({
        error: "Too many active SSE sessions. Try again later."
      });
      return;
    }

    const server = createOpenBrainMcpServer(runtime.service, {
      observer: runtime.observer,
      clientId: profile.id,
      serviceName: runtime.config.serviceName,
      serviceVersion: runtime.config.serviceVersion,
      defaultFilterState: selectDefaultFilterState(runtime.config, profile),
      allowedTools: profile.allowedTools,
      allowedFilterStates: profile.allowedFilterStates
    });
    let isClosing = false;

    try {
      const transport = new SSEServerTransport(messagesPath, res);
      const sessionId = transport.sessionId;
      const sessionKey = buildSessionKey(profile.id, sessionId);
      sessions.set(sessionKey, {
        transport
      });

      transport.onclose = () => {
        sessions.delete(sessionKey);

        if (isClosing) {
          return;
        }

        isClosing = true;
        void server.close().catch(() => undefined);
      };

      await server.connect(transport);
    } catch (error) {
      isClosing = true;
      handleAppError(req, res, error);
      void server.close().catch(() => undefined);
    }
  });

  router.post("/messages", async (req, res) => {
    const profile = res.locals.clientProfile as ClientProfile;
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;

    if (!sessionId) {
      res.status(400).json({ error: "Missing sessionId query parameter" });
      return;
    }

    const session = sessions.get(buildSessionKey(profile.id, sessionId));

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      handleAppError(req, res, error);
    }
  });

  router.post("/", async (req, res) => {
    const runtime = res.locals.runtime as RuntimeDependencies;
    const profile = res.locals.clientProfile as ClientProfile;
    const server = createOpenBrainMcpServer(runtime.service, {
      observer: runtime.observer,
      clientId: profile.id,
      serviceName: runtime.config.serviceName,
      serviceVersion: runtime.config.serviceVersion,
      defaultFilterState: selectDefaultFilterState(runtime.config, profile),
      allowedTools: profile.allowedTools,
      allowedFilterStates: profile.allowedFilterStates
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      handleAppError(req, res, error);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  router.get("/", (_req, res) => {
    res.status(405).json(jsonRpcError("Method not allowed."));
  });

  router.delete("/", (_req, res) => {
    res.status(405).json(jsonRpcError("Method not allowed."));
  });

  app.use(mountPath, router);
}

function applyCorsHeaders(
  req: Request,
  res: Response,
  profile: ClientProfile
): boolean {
  const origin = req.header("origin");

  if (!origin) {
    return true;
  }

  const wildcard = profile.allowedOrigins.includes("*");
  const allowed = wildcard || profile.allowedOrigins.includes(origin);

  if (!allowed) {
    return false;
  }

  if (wildcard) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Cache-Control"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "3600");

  return true;
}

function isAuthorized(req: Request, expectedToken: string): boolean {
  const header = req.header("authorization");
  let providedToken: string | undefined;

  if (header?.startsWith("Bearer ")) {
    providedToken = header.slice("Bearer ".length).trim();
  } else if (typeof req.query.auth_token === "string") {
    providedToken = req.query.auth_token;
  }

  if (!providedToken) {
    return false;
  }

  const expectedBytes = Buffer.from(expectedToken);
  const providedBytes = Buffer.from(providedToken);

  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }

  return timingSafeEqual(expectedBytes, providedBytes);
}

function jsonRpcError(message: string) {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message
    },
    id: null
  };
}

function buildSessionKey(profileId: string, sessionId: string): string {
  return `${profileId}:${sessionId}`;
}

function selectDefaultFilterState(
  config: AppConfig,
  profile: ClientProfile
) {
  return profile.allowedFilterStates.includes(config.defaultFilterState)
    ? config.defaultFilterState
    : profile.allowedFilterStates[0];
}

function handleAppError(req: Request, res: Response, error: unknown): void {
  if (res.headersSent) {
    console.warn("openBrainMcp error dropped (headers already sent)", {
      method: req.method,
      path: req.originalUrl,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error
    });
    return;
  }

  const requestId = randomUUID();

  console.error("openBrainMcp request failed", {
    requestId,
    method: req.method,
    path: req.originalUrl,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        : error
  });

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      error: error.message,
      requestId
    });
    return;
  }

  if (error instanceof MissingConfigurationError) {
    res.status(503).json({
      error: "Service unavailable",
      requestId
    });
    return;
  }

  res.status(500).json({
    error: "Internal server error",
    requestId
  });
}

async function recordRequestEvent(
  options: CreateAppOptions,
  clientId: string,
  req: Request,
  status: "rejected" | "degraded",
  statusCode: number,
  reason: "origin_not_allowed" | "unauthorized" | "sse_capacity_exceeded",
  startedAt: number | undefined
): Promise<void> {
  try {
    await options.getObserver().recordRequest({
      client_id: clientId,
      method: req.method,
      path: req.originalUrl,
      status,
      status_code: statusCode,
      reason,
      latency_ms: startedAt ? Date.now() - startedAt : undefined
    });
  } catch (error) {
    console.error("openBrainMcp request event failed", {
      client_id: clientId,
      method: req.method,
      path: req.originalUrl,
      status,
      status_code: statusCode,
      reason,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack
            }
          : error
    });
  }
}
