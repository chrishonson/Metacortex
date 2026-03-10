import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type Request, type Response } from "express";

import { MissingConfigurationError } from "./config.js";
import { createOpenBrainMcpServer } from "./mcpServer.js";
import { type RuntimeDependencies } from "./runtime.js";

type ActiveSession =
  | {
      kind: "sse";
      transport: SSEServerTransport;
    }
  | {
      kind: "streamable";
      transport: StreamableHTTPServerTransport;
    };

export interface CreateAppOptions {
  getAuthToken: () => string;
  getRuntime: () => RuntimeDependencies;
}

export function createOpenBrainApp(options: CreateAppOptions) {
  const app = express();
  const sessions = new Map<string, ActiveSession>();

  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    applyCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "firebase-open-brain",
      endpoints: ["/mcp", "/mcp/sse", "/mcp/messages"]
    });
  });

  app.use("/mcp", (req, res, next) => {
    let authToken: string;

    try {
      authToken = options.getAuthToken();
    } catch (error) {
      handleAppError(res, error);
      return;
    }

    if (!isAuthorized(req, authToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="firebase-open-brain"');
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      res.locals.runtime = options.getRuntime();
      next();
    } catch (error) {
      handleAppError(res, error);
    }
  });

  app.get("/mcp/sse", async (_req, res) => {
    const runtime = res.locals.runtime as RuntimeDependencies;
    const server = createOpenBrainMcpServer(runtime.service, runtime.config);
    let isClosing = false;

    try {
      const transport = new SSEServerTransport("/mcp/messages", res);
      const sessionId = transport.sessionId;
      sessions.set(sessionId, {
        kind: "sse",
        transport
      });

      transport.onclose = () => {
        sessions.delete(sessionId);

        if (isClosing) {
          return;
        }

        isClosing = true;
        void server.close().catch(() => undefined);
      };

      await server.connect(transport);
    } catch (error) {
      isClosing = true;
      handleAppError(res, error);
      void server.close().catch(() => undefined);
    }
  });

  app.post("/mcp/messages", async (req, res) => {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;

    if (!sessionId) {
      res.status(400).json({ error: "Missing sessionId query parameter" });
      return;
    }

    const session = sessions.get(sessionId);

    if (!session || session.kind !== "sse") {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      handleAppError(res, error);
    }
  });

  app.post("/mcp", async (req, res) => {
    const runtime = res.locals.runtime as RuntimeDependencies;
    const server = createOpenBrainMcpServer(runtime.service, runtime.config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      handleAppError(res, error);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json(jsonRpcError("Method not allowed."));
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json(jsonRpcError("Method not allowed."));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

function applyCorsHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Cache-Control"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function isAuthorized(req: Request, expectedToken: string): boolean {
  const header = req.header("authorization");

  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const providedToken = header.slice("Bearer ".length).trim();
  return providedToken.length > 0 && providedToken === expectedToken;
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

function handleAppError(res: Response, error: unknown): void {
  if (res.headersSent) {
    return;
  }

  if (error instanceof MissingConfigurationError) {
    res.status(500).json({
      error: error.message
    });
    return;
  }

  const message =
    error instanceof Error ? error.message : "Unexpected application error";

  res.status(500).json({
    error: message,
    requestId: randomUUID()
  });
}
