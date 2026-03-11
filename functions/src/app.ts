import { randomUUID, timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type Request, type Response } from "express";

import { type AppConfig, type ClientProfile, MissingConfigurationError } from "./config.js";
import { HttpError } from "./errors.js";
import { createOpenBrainMcpServer } from "./mcpServer.js";
import { type RuntimeDependencies } from "./runtime.js";

interface ActiveSession {
  transport: SSEServerTransport;
}

export interface CreateAppOptions {
  getConfig: () => AppConfig;
  getRuntime: () => RuntimeDependencies;
}

export function createOpenBrainApp(options: CreateAppOptions) {
  const app = express();
  const sessions = new Map<string, ActiveSession>();

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "firebase-open-brain",
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
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    if (!isAuthorized(req, profile.authToken)) {
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
      res.status(503).json({
        error: "Too many active SSE sessions. Try again later."
      });
      return;
    }

    const server = createOpenBrainMcpServer(runtime.service, {
      serviceName: runtime.config.serviceName,
      serviceVersion: runtime.config.serviceVersion,
      defaultFilterState: runtime.config.defaultFilterState,
      allowedTools: profile.allowedTools
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
      serviceName: runtime.config.serviceName,
      serviceVersion: runtime.config.serviceVersion,
      defaultFilterState: runtime.config.defaultFilterState,
      allowedTools: profile.allowedTools
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

  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const providedToken = header.slice("Bearer ".length).trim();

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

function handleAppError(req: Request, res: Response, error: unknown): void {
  if (res.headersSent) {
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
