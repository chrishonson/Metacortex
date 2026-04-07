# Persistent Memory for ChatGPT + Claude — Serverless Firebase MCP Memory

Your agents finally remember everything across sessions — no local DB, no Docker, just Firebase vector search + scoped browser endpoints.

MetaCortex gives browser-based assistants a shared, durable memory layer without asking you to run your own vector database or long-lived backend. This kit packages the proven Firebase deployment workflow so you can stand up one remote MCP memory service, connect ChatGPT and Claude to scoped endpoints, and let multiple clients remember, search, and fetch the same project knowledge.

## Quick Start

```bash
journey install agentnightshift/metacortex-mcp-memory-firebase
```

After install, Journey will place the kit files in your workspace, guide you through Firebase and Gemini setup, and point you at the bundled verification flow.

## When to Use

- You want ChatGPT web, Claude web, or other MCP clients to share one hosted memory service.
- You prefer Firebase-managed infrastructure over running Postgres, Redis, or a self-hosted vector database.
- You need durable retrieval with scoped browser endpoints instead of giving every client full admin access.
- You want a deployable memory backend with real source files, tests, indexes, and smoke verification included.

## How It Works

1. The kit installs the exact Firebase config, Functions code, Firestore indexes, and verification scripts that were used to validate MetaCortex.
2. You bind the kit to your Firebase project, add Gemini and bearer-token secrets, and deploy the bundled indexes and Cloud Function.
3. MetaCortex exposes a protected admin MCP endpoint plus scoped browser client endpoints for ChatGPT and Claude.
4. Clients use `remember_context`, `search_context`, and `fetch_context` over Streamable HTTP MCP while Firestore stores canonical memory records and vector embeddings.
5. The bundled verifier runs local tests and build checks first, then optionally exercises the deployed endpoint with a smoke test when deployment credentials are present.

> [!IMPORTANT]
> Browser clients should use scoped client profiles, not the admin endpoint. Keep maintenance tools such as `deprecate_context` off public browser connections.

## Setup

### Models

| Role | Tested with | Flexibility | Purpose |
| --- | --- | --- | --- |
| Packaging and validation agent | `gpt-5.4` | Any comparable agent runtime can follow the workflow, but `gpt-5.4` is the verified model recorded in the kit. | Assemble, validate, and publish the kit workflow. |
| Embeddings | `text-embedding-004` | Treat as pinned unless you are prepared to update the environment and rebuild Firestore indexes for a new vector space. | Convert memory content and search queries into 768-dimensional vectors. |
| Multimodal normalization | `gemini-3.1-flash-lite-preview` | Replaceable only with code and configuration changes. | Turn image inputs into retrieval-ready text before embedding. |

### Services

| Service | Flexibility | Why it matters |
| --- | --- | --- |
| Firebase Cloud Functions 2nd Gen | Required for the shipped workflow | Hosts the remote MCP HTTP service. |
| Firestore Native mode | Required for the shipped workflow | Stores memory documents, audit events, and vector indexes. |
| Gemini API | Required for the shipped workflow | Supplies embeddings and multimodal preprocessing. |

### Prerequisites

| Requirement | Why you need it |
| --- | --- |
| Node.js 22 | Matches the packaged runtime and verification scripts. |
| npm | Installs Functions dependencies and runs tests and builds. |
| Firebase CLI | Selects a project, deploys indexes, and deploys the Cloud Function. |
| Firebase Blaze plan | Required for Cloud Functions 2nd Gen production deploys. |

### Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes | Enables embeddings and multimodal normalization. |
| `MCP_ADMIN_TOKEN` | Yes | Protects the default admin MCP endpoint. |
| `MCP_CLIENT_PROFILES_JSON` | Recommended | Defines scoped ChatGPT and Claude browser clients. |
| `GEMINI_EMBEDDING_DIMENSIONS` | Defaulted | Must stay aligned with the bundled Firestore vector indexes. |
| `MEMORY_COLLECTION` | Defaulted | Sets the Firestore collection for stored memories. |
| `SEARCH_RESULT_LIMIT` | Defaulted | Caps search results returned by the service. |
| `DEFAULT_FILTER_STATE` | Defaulted | Controls the default branch-state filter for client searches. |

### Parameters

| Parameter | Value | Why it was chosen |
| --- | --- | --- |
| `GEMINI_EMBEDDING_DIMENSIONS` | `768` | Matches the bundled Firestore vector indexes and the verified embedding model. |
| `MEMORY_COLLECTION` | `memory_vectors` | Keeps all durable memories in one server-only collection. |
| `SEARCH_RESULT_LIMIT` | `5` | Returns compact, high-signal search results by default. |
| `DEFAULT_FILTER_STATE` | `active` | Keeps deprecated or draft records out of normal client retrieval. |
| Region | `us-central1` | Matches the deployed Cloud Functions configuration in the bundled code. |

## Inputs & Outputs

### Inputs

| Input | Description |
| --- | --- |
| Firebase project | A Firebase project with Blaze enabled and Firestore available in Native mode. |
| Runtime secrets | Gemini key, admin token, and scoped browser client tokens. |
| Function base URL | The deployed HTTPS base URL used for MCP client registration and smoke verification. |

### Outputs

| Output | Description |
| --- | --- |
| Remote MCP memory service | A hosted MetaCortex endpoint backed by Firestore vector search. |
| Scoped browser endpoints | Safe ChatGPT and Claude connections limited to memory read/write tools. |
| Verification evidence | Passing tests, build output, and optional deployed smoke-test results. |

## Constraints

- Firestore must be in Native mode.
- The shipped deployment path assumes Firebase Cloud Functions 2nd Gen in `us-central1`.
- Embedding dimensions and Firestore vector indexes must match exactly.
- If you change embedding providers or dimensions, use a new collection or rebuild the stored vectors instead of mixing vector spaces.
- The kit is self-contained for deployment, but it still depends on your own Firebase and Gemini accounts.

## Why This Kit Exists

Most memory demos stop at prompts or architectural diagrams. This kit ships the operational slice that actually mattered: deployable Firebase config, Firestore indexes, scoped browser-client guidance, tests, and smoke verification. If you want a real hosted MCP memory backend instead of another aspirational template, this is the packaged path.
