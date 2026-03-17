# Visual Design & System Architecture

Firebase Open Brain is a serverless MCP (Model Context Protocol) memory service. This document visualizes the system boundaries, personas, and primary use cases to provide a clear mental model of the ecosystem.

## 👥 Personas

| Persona | Role | Primary Toolset |
| :--- | :--- | :--- |
| **The Developer** | Builds and extends the project. | `firebase deploy`, `npm test`, CLI tools. |
| **Nanobot** | Local AI Agent inheriting this memory. | `search_context`, `remember_context`. |
| **The AI Assistant** | Browser-hosted assistant (ChatGPT/Claude). | `search_context`, `remember_context`, `fetch_context`. |
| **The Operator** | Manages the memory corpus. | `deprecate_context`, `get_consolidation_queue`. |

## 🏗️ System Boundaries

The system is partitioned into trust zones to ensure security and scalability.

```mermaid
graph TD
    subgraph "External World"
        A["ChatGPT / Claude (Browser)"]
        B["Nanobot (Local Agent)"]
    end

    subgraph "Firebase Secure Zone"
        direction TB
        subgraph "Cloud Functions"
            C["Scoped MCP<br/>Endpoints"]
            D["Admin MCP<br/>Endpoint"]
        end
        
        subgraph "Firestore"
            E[("memory_vectors<br/>(Durable Memory)")]
            F[("memory_events<br/>(Audit Logs)")]
        end
        
        subgraph "Gemini Core"
            G["Embedding API"]
            H["Multimodal API"]
        end
    end

    A -- "Scoped Token" --> C
    B -- "Admin Token" --> D
    
    C --> E
    D --> E
    C --> F
    D --> F
    
    E -- "Vector Search" --> G
    C -- "Normalization" --> H
```

> [!NOTE]
> **Normalization Path**: Since vector search is text-based, the system "normalizes" image memories into descriptive text using Gemini. This allows semantic search to find visual content (like screenshots) using natural language queries.

## 🔄 Primary Use Cases

### 1. Persistent Memory Growth
The AI Assistant saves new project decisions or requirements on behalf of the user.

```mermaid
sequenceDiagram
    participant U as User
    participant A as AI Assistant
    participant S as MCP Server
    participant G as Gemini
    participant F as Firestore

    U->>A: "Remember that we use Ktor."
    A->>S: remember_context(content)
    S->>G: Embed text
    G-->>S: Vector [768]
    S->>F: Store Vector + Metadata
    S-->>A: Memory ID Created
    A-->>U: "Saved to project memory."
```

### 2. Contextual Retrieval (The "Open Brain")
The Assistant searches the project's memory to answer a user's question.

```mermaid
sequenceDiagram
    participant U as User
    participant A as AI Assistant
    participant S as MCP Server
    participant F as Firestore

    U->>A: "How do we handle networking?"
    A->>S: search_context(query)
    S->>F: findNearest(query_vector)
    F-->>S: Top 5 Matches
    S-->>A: Match Results + Snippets
    A->>U: "We use Ktor for Android/iOS..."
```

## 🎨 Conceptual Visualization: Brain & Body

The relationship between the **Open Brain** and **Nanobot** is one of remote intelligence and local manifestation. The "Brain" resides in the cloud (Firebase/Gemini), providing durable memory and reasoning, while Nanobot acts as its "Body" on the local machine, executing tasks and interacting with the local environment.

![Final unified conceptual architecture showing the Cloud Intelligence (Open Brain, ChatGPT, Claude) and the Local Body (Nanobot)](graphics/architecture.png)
