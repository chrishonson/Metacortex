---
{
  "schema": "kit/1.0",
  "slug": "metacortex-mcp-memory-firebase",
  "title": "Persistent Memory for ChatGPT + Claude — Serverless Firebase MCP Memory",
  "summary": "Deploy MetaCortex on Firebase to give ChatGPT, Claude, and other MCP clients durable searchable memory over Streamable HTTP MCP.",
  "version": "1.0.1",
  "license": "MIT",
  "tags": [
    "mcp",
    "memory",
    "firebase",
    "firestore",
    "chatgpt",
    "claude",
    "gemini"
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
      "name": "gemini-3.1-flash-lite-preview",
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
      "setup": "Requires GEMINI_API_KEY and uses text-embedding-004 plus gemini-3.1-flash-lite-preview."
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
      "problem": "ChatGPT web cannot reliably send custom bearer headers for MCP connections.",
      "resolution": "Use the tokenized scoped endpoint URL for ChatGPT while keeping bearer-token support for other clients.",
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
      "MCP_ADMIN_TOKEN"
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

Stand up MetaCortex as a remote, durable MCP memory service on Firebase so browser-hosted assistants and other MCP clients can remember, search, and fetch project memory over Streamable HTTP.

## When to Use

Use this kit when you want a managed remote memory backend instead of a local vector database. It fits teams that want ChatGPT web, Claude web, or other MCP-capable clients to share durable memory through one hosted service with separate admin and browser-scoped endpoints.

## Inputs

You need a Firebase project with Blaze enabled, Firestore in Native mode, and a Gemini API key. You also need one admin token plus separate browser-client tokens so ChatGPT and Claude can be scoped to the safe three-tool contract.

The install flow assumes you can deploy Cloud Functions and then register the resulting HTTPS endpoints in the target MCP clients. Bring your own naming for client IDs and tokens if you want to diverge from the bundled `chatgpt-web` and `claude-web` examples.

## Setup

### Models

MetaCortex is verified here with `gpt-5.4` as the packaging and validation agent model. Runtime retrieval depends on Gemini APIs: `text-embedding-004` for embeddings at 768 dimensions and `gemini-3.1-flash-lite-preview` for image-to-text normalization before embedding.

### Services

Deploy the included Firebase project files, then provision Firestore indexes before the function. The service expects Firestore Native mode, Cloud Functions 2nd Gen in `us-central1`, and a Gemini API key available to the function process.

### Parameters

Keep `GEMINI_EMBEDDING_DIMENSIONS=768` aligned with the bundled Firestore vector indexes. The public defaults in this kit assume `MEMORY_COLLECTION=memory_vectors`, `SEARCH_RESULT_LIMIT=5`, and `DEFAULT_FILTER_STATE=active`.

### Environment

The bundled workflow assumes Node.js 22, npm, and the Firebase CLI on macOS or Linux. The deployment flow is production-oriented and uses `functions/.env.prod` for the deploy target; local emulator work remains optional.

## Steps

1. Install the packaged function dependencies:

   ```bash
   npm --prefix functions install
   ```

2. Create the production env file from the bundled template and fill in your real values:

   ```bash
   cp functions/.env.example functions/.env.prod
   ```

   Use the bundled template as the source of truth for the full variable list. Replace the placeholder values for:

   - `GEMINI_API_KEY`
   - `MCP_ADMIN_TOKEN`
   - scoped client tokens inside `MCP_CLIENT_PROFILES_JSON`

   Keep these non-secret defaults aligned with the shipped Firebase indexes and code:

   - `GEMINI_EMBEDDING_MODEL`: `text-embedding-004`
   - `GEMINI_MULTIMODAL_MODEL`: `gemini-3.1-flash-lite-preview`
   - `GEMINI_EMBEDDING_DIMENSIONS`: `768`
   - `MEMORY_COLLECTION`: `memory_vectors`

3. Authenticate the Firebase CLI and bind the bundle to the target project because `.firebaserc` is not shipped:

   ```bash
   firebase login
   firebase use --add
   ```

   If you already know the alias or project binding, `firebase use <alias>` is sufficient.

4. Run the bundled preflight to catch git-state, env, index-dimension, test, and build issues before deploy:

   ```bash
   ./scripts/deploy-session-preflight.sh
   ```

5. Deploy Firestore rules and indexes first, then deploy the function:

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   firebase deploy --only functions
   ```

6. Capture the deployed function base URL and register scoped browser endpoints instead of the admin endpoint:

   ```text
   https://<FUNCTION_BASE_URL>/clients/chatgpt-web/mcp?auth_token=<CHATGPT_TOKEN>
   https://<FUNCTION_BASE_URL>/clients/claude-web/mcp
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

8. Register the matching values in ChatGPT and Claude. ChatGPT should use the tokenized URL and "No Authentication"; Claude can use either bearer auth or the tokenized URL if the client UI does not support headers.

## Outputs

After the workflow succeeds you have one remote MCP service, one admin endpoint, and at least two scoped browser endpoints that expose only `remember_context`, `search_context`, and `fetch_context`. You also have repeatable smoke-test commands and a deploy preflight script that can be reused for future releases.

The bundled repo slice is enough to keep iterating on the service without fetching extra application files. Another agent can inspect the shipped TypeScript source, tests, and Firebase config directly from the installed kit.

## Failures Overcome

The main operational mistakes are predictable: trying to deploy on Spark, letting index dimensions drift from the embedding model, assuming ChatGPT can send bearer headers, or accidentally exposing the admin tool surface to browsers. This kit bakes those lessons into the setup and endpoint registration steps so the install contract stays safe by default.

## Validation

Local verification should always pass before you deploy:

```bash
node scripts/verify-journey-kit-install.mjs
```

That script runs `npm --prefix functions test` and `npm --prefix functions run build`. If `MCP_BASE_URL` and `MCP_ADMIN_TOKEN` are not set, it exits successfully after the local checks and reports that deployed smoke verification was skipped.

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
- Keep `deprecate_context` off browser-facing profiles so assistants cannot mutate memory lifecycle state from the public surface.
- Do not ingest secrets or credentials into MetaCortex memories. Stored content is designed for retrieval, not secret management.
- Add production rate limits, careful token handling, and narrow allowed origins before exposing the service to shared users.
