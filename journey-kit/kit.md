---
{
  "schema": "kit/1.0",
  "slug": "metacortex-mcp-memory-firebase",
  "title": "Persistent Memory for ChatGPT + Claude — Serverless Firebase MCP Memory",
  "summary": "MCP memory for every agent: deploy MetaCortex on Firebase for durable searchable context over Streamable HTTP MCP endpoints.",
  "version": "1.0.2",
  "license": "MIT",
  "tags": [
    "mcp",
    "memory",
    "mcp-memory",
    "firebase",
    "firestore",
    "chatgpt",
    "claude",
    "gemini",
    "firebase-memory",
    "persistent-context",
    "vector-search",
    "chatgpt-memory",
    "claude-memory",
    "serverless-mcp"
  ],
  "model": {
    "provider": "openai",
    "name": "gpt-5.4",
    "hosting": "cloud API — requires an OpenAI-hosted GPT-5.4 capable agent runtime"
  },
  "tools": [
    "terminal",
    "firebase-cli",
    "node",
    "curl",
    "mcp-client"
  ],
  "skills": [],
  "tech": [
    "typescript",
    "firebase-cloud-functions",
    "firestore",
    "gemini",
    "express"
  ],
  "models": [
    {
      "role": "embedding",
      "provider": "google",
      "name": "text-embedding-004",
      "hosting": "cloud API — requires GEMINI_API_KEY",
      "config": {
        "dimension": 768
      }
    },
    {
      "role": "multimodal-normalization",
      "provider": "google",
      "name": "gemini-3.1-flash-lite",
      "hosting": "cloud API — requires GEMINI_API_KEY"
    }
  ],
  "services": [
    {
      "name": "Firebase Cloud Functions 2nd Gen",
      "kind": "serverless runtime",
      "role": "hosts the remote MCP service and scoped HTTP endpoints",
      "setup": "Requires a Firebase project on the Blaze plan and a deployed Cloud Functions 2nd Gen service."
    },
    {
      "name": "Firestore Native mode",
      "kind": "document database",
      "role": "stores durable memories, vector indexes, and audit events",
      "setup": "Requires Firestore in Native mode with the bundled vector indexes deployed before the function."
    },
    {
      "name": "Gemini API",
      "kind": "AI API",
      "role": "provides text embeddings and image-to-text normalization",
      "setup": "Requires GEMINI_API_KEY and uses text-embedding-004 plus gemini-3.1-flash-lite."
    }
  ],
  "parameters": [
    {
      "name": "GEMINI_EMBEDDING_DIMENSIONS",
      "value": "768",
      "description": "Must match every bundled Firestore vector index."
    },
    {
      "name": "MEMORY_COLLECTION",
      "value": "memory_vectors",
      "description": "Primary Firestore collection for stored memories."
    },
    {
      "name": "SEARCH_RESULT_LIMIT",
      "value": "5",
      "description": "Default result cap for vector search."
    },
    {
      "name": "DEFAULT_FILTER_STATE",
      "value": "active",
      "description": "Default branch-state filter returned to public clients."
    },
    {
      "name": "region",
      "value": "us-central1",
      "description": "Bundled Cloud Function deployment region."
    }
  ],
  "failures": [
    {
      "problem": "Cloud Functions production deployment does not work on the Firebase Spark plan.",
      "resolution": "Require the Blaze plan for production and call it out before deployment begins.",
      "scope": "general"
    },
    {
      "problem": "Embedding writes fail or retrieval quality breaks when Firestore vector indexes use a different dimension than the embedding model.",
      "resolution": "Pin text-embedding-004 at 768 dimensions and deploy matching indexes before storing memories.",
      "scope": "general"
    },
    {
      "problem": "MCP authentication support differs across client versions.",
      "resolution": "Verify authentication supported by each client version. URL tokens remain legacy compatibility only, pending replacement-authentication verification and breaking-release removal.",
      "scope": "general"
    },
    {
      "problem": "Exposing the admin endpoint to browser clients would leak maintenance tools such as deprecate_context.",
      "resolution": "Use scoped client profiles for ChatGPT and Claude and keep the admin endpoint separate with its own token.",
      "scope": "general"
    }
  ],
  "inputs": [
    {
      "name": "Firebase project",
      "description": "A Firebase project with Blaze enabled and Firestore available in Native mode."
    },
    {
      "name": "Runtime secrets",
      "description": "GEMINI_API_KEY, MCP_ADMIN_TOKEN, and distinct scoped client tokens for browser consumers."
    },
    {
      "name": "Function base URL",
      "description": "The deployed Cloud Functions base URL used to register MCP clients and run smoke tests."
    }
  ],
  "outputs": [
    {
      "name": "Remote MCP memory service",
      "description": "A deployed MetaCortex HTTP MCP endpoint backed by Firestore vector search."
    },
    {
      "name": "Browser-scoped MCP endpoints",
      "description": "Dedicated ChatGPT and Claude client URLs with restricted tool access."
    },
    {
      "name": "Deployment verification evidence",
      "description": "Passing tests, successful build output, and smoke-test responses from the deployed endpoints."
    }
  ],
  "useCases": [
    {
      "scenario": "Provision remote durable memory for ChatGPT web, Claude web, and other MCP clients without running your own database servers.",
      "constraints": [
        "Requires Firebase, Firestore Native mode, and Gemini API access."
      ],
      "notFor": [
        "Teams that need a self-hosted database instead of Firebase-managed infrastructure."
      ]
    }
  ],
  "prerequisites": [
    {
      "name": "Node.js 22",
      "check": "node --version"
    },
    {
      "name": "npm",
      "check": "npm --version"
    },
    {
      "name": "Firebase CLI",
      "check": "firebase --version"
    }
  ],
  "dependencies": {
    "runtime": {
      "node": "22"
    },
    "npm": {},
    "cli": [
      "firebase"
    ],
    "secrets": [
      "GEMINI_API_KEY",
      "MCP_ADMIN_TOKEN",
      "MCP_CLIENT_PROFILES_JSON"
    ],
    "kits": []
  },
  "verification": {
    "command": "node scripts/verify-journey-kit-install.mjs",
    "expected": "Runs local test and build checks, then runs deployed smoke validation when MCP_BASE_URL and MCP_ADMIN_TOKEN are present."
  },
  "selfContained": true,
  "orgRequired": false,
  "requiredResources": [],
  "environment": {
    "runtime": "node",
    "os": [
      "linux",
      "macos"
    ],
    "platforms": [
      "ChatGPT web",
      "Claude web"
    ],
    "notes": "The bundled shell scripts and examples assume a POSIX shell and Firebase CLI workflow.",
    "adaptationNotes": "On Windows, translate shell commands to PowerShell equivalents and keep the same environment variable names and Firebase settings."
  }
}
---

# Persistent Memory for ChatGPT + Claude — Serverless Firebase MCP Memory

## Goal

MetaCortex provides a shared memory layer in the owner’s Firebase project for compatible MCP clients. Verify the authentication and tool contract of each client version.

No custom vector DB. No long-running server. Just deploy once and your agents get durable `save_context` / `search_context` / `fetch_context` with image-to-text normalization — over scoped endpoints with bearer authentication.

Used daily by the author as their personal MCP memory backend. Already powers multiple agents across ChatGPT and Claude in production.

Full source and documentation: https://github.com/chrishonson/Metacortex

## When to Use

Use this kit when you want a managed remote memory backend instead of a local vector database. It fits teams that want ChatGPT web, Claude web, or other MCP-capable clients to share durable memory through one hosted service with separate admin and browser-scoped endpoints.

## Inputs

You need a Firebase project with Blaze enabled, Firestore in Native mode, and a Gemini API key. You also need one admin token plus separate browser-client tokens so ChatGPT and Claude can be scoped to the safe three-tool contract.

The install flow assumes you can deploy Cloud Functions and then register the resulting HTTPS endpoints in the target MCP clients. Bring your own naming for client IDs and tokens if you want to diverge from the bundled `chatgpt-web` and `claude-web` examples.

## Setup

### Models

MetaCortex is verified here with `gpt-5.4` as the packaging and validation agent model. Runtime retrieval depends on Gemini APIs: `text-embedding-004` for embeddings at 768 dimensions and `gemini-3.1-flash-lite` for image-to-text normalization before embedding.

### Services

Deploy the included Firebase project files, then provision Firestore indexes before the function. The service expects Firestore Native mode, Cloud Functions 2nd Gen in `us-central1`, and a Gemini API key available to the function process.

### Parameters

Keep `GEMINI_EMBEDDING_DIMENSIONS=768` aligned with the bundled Firestore vector indexes. The public defaults in this kit assume `MEMORY_COLLECTION=memory_vectors`, `SEARCH_RESULT_LIMIT=5`, and `DEFAULT_FILTER_STATE=active`.

### Environment

The bundled workflow assumes Node.js 22, npm, and the Firebase CLI on macOS or Linux. The deployment flow is production-oriented and uses `functions/.env.prod` for non-secret settings and Secret Manager for credentials; local emulator work remains optional.

## Steps

1. Install the packaged function dependencies:

   ```bash
   npm --prefix functions install
   ```

2. Authenticate and bind the kit to your own project because `.firebaserc` is not shipped. Choose an alias, such as `prod`, for that project:

   ```bash
   firebase login
   firebase use --add
   ```

3. Create `functions/.env.<alias>` with only the non-secret settings from `functions/.env.example`. Omit `GEMINI_API_KEY`, `MCP_ADMIN_TOKEN`, and `MCP_CLIENT_PROFILES_JSON` entirely, including their placeholder assignments. Store these as secrets against the project you selected:

   ```bash
   firebase functions:secrets:set GEMINI_API_KEY --project <project-id>
   firebase functions:secrets:set MCP_ADMIN_TOKEN --project <project-id>
   firebase functions:secrets:set MCP_CLIENT_PROFILES_JSON --project <project-id>
   ```

   Keep `GEMINI_EMBEDDING_MODEL=text-embedding-004`, `GEMINI_MULTIMODAL_MODEL=gemini-3.1-flash-lite`, `GEMINI_EMBEDDING_DIMENSIONS=768`, and `MEMORY_COLLECTION=memory_vectors` aligned with the bundled code/indexes. Validate model access before deployment; defaults do not guarantee live availability. See `docs/DEPLOYMENT.md` for Vertex/API-key behavior.

4. Run local verification:

   ```bash
   node scripts/verify-journey-kit-install.mjs
   ```

   Leave smoke credentials unset for this local-only check. The included `scripts/deploy-session-preflight.sh` and some operator scripts retain maintainer-specific defaults; do not run them against a new installation without inspecting their targets. Portable provisioning remains planned work.

5. Verify the chosen alias, matching dotenv file, secrets, and billing, then deploy rules/indexes followed by the function. Wait for indexes to become ready:

   ```bash
   firebase deploy --project <alias> --only firestore:rules,firestore:indexes
   firebase deploy --project <alias> --only functions
   ```

6. Capture the deployed function base URL and register scoped browser endpoints instead of the admin endpoint:

   ```text
   https://<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp
   ```

   Keep the admin endpoint separate:

   ```text
   https://<FUNCTION_BASE_URL>/mcp
   ```

7. Run smoke tests against the deployed service. Start with admin validation, then verify one scoped browser endpoint:

   ```bash
   npm --prefix functions run smoke -- \
     --url "https://<FUNCTION_BASE_URL>/mcp" \
     --token "<ADMIN_TOKEN>" \
     --mode admin-read-write
   ```

   ```bash
   npm --prefix functions run smoke -- \
     --url "https://<FUNCTION_BASE_URL>/clients/chatgpt-web/mcp" \
     --token "<CHATGPT_TOKEN>" \
     --mode browser-read-write
   ```

8. Register the endpoint in each client with its bearer credential where the client supports it. Current code still accepts `?auth_token=<SCOPED_TOKEN>` as legacy behavior for URL-only clients. That token is part of the URL and may be logged. It is scheduled for removal after OAuth migration, and no client compatibility is verified here.

## Outputs

After the workflow succeeds you have one remote MCP service, one admin endpoint, and at least two scoped browser endpoints that expose only `save_context`, `search_context`, and `fetch_context`. You also have repeatable smoke-test commands and the existing maintainer preflight; inspect its project assumptions before reuse.

The bundled repo slice is enough to keep iterating on the service without fetching extra application files. Another agent can inspect the shipped TypeScript source, tests, and Firebase config directly from the installed kit.

## Failures Overcome

The main operational mistakes are predictable: trying to deploy on Spark, letting index dimensions drift from the embedding model, assuming every client version supports bearer headers, or accidentally exposing the admin tool surface to browsers. This kit bakes those lessons into the setup and endpoint registration steps so the install contract stays conservative by default.

## Validation

Local verification should always pass before you deploy:

```bash
node scripts/verify-journey-kit-install.mjs
```

That script runs tests, the Functions build, and operator script typechecks. If `MCP_BASE_URL` and `MCP_ADMIN_TOKEN` are not set, it exits successfully after the local checks and reports that deployed smoke verification was skipped.

Once a real endpoint exists, rerun the same root verification entrypoint with the deployment env vars set:

```bash
npm --prefix functions run smoke -- \
  --url "https://<FUNCTION_BASE_URL>/mcp" \
  --token "<ADMIN_TOKEN>" \
  --mode admin-read-write
```

Or export `MCP_BASE_URL` plus `MCP_ADMIN_TOKEN` first and run the root verifier. In that mode the script performs the same local checks and then runs the bundled smoke validation. A successful run lists the expected tools, creates a memory when write access is allowed, and returns searchable results from the deployed service.

## Constraints

- Firebase Blaze is required for production Cloud Functions deployment.
- Firestore must be in Native mode, not Datastore mode.
- `GEMINI_EMBEDDING_DIMENSIONS` must match the bundled vector indexes exactly.
- Do not mix embeddings from different models or dimensions in the same Firestore collection.
- Browser clients should never receive `deprecate_context`; keep maintenance access on the admin endpoint only.

## Safety Notes

- Never publish real tokens, API keys, or project-specific secrets in `.env` files, examples, or client registration screenshots.
- Do not expose the admin `/mcp` endpoint to browser-hosted clients. Use scoped `/clients/<clientId>/mcp` endpoints instead.
- Keep both maintenance tools off ordinary profiles. Current read-state allowlists do not enforce write-state restrictions; server-side enforcement is planned.
- Do not ingest secrets or credentials into MetaCortex memories. Stored content is designed for retrieval, not secret management.
- This is one owner’s shared agent corpus. Rate limits and owner/OAuth management remain roadmap work; profiles do not provide tenant isolation.
