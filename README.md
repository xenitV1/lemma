# Lemma - Persistent Memory for LLMs via MCP

[English](README.md) | [Türkçe](README.tr.md)

Lemma is a Model Context Protocol (MCP) server that provides a persistent memory layer for Large Language Models. It enables LLMs to remember facts, preferences, and context across sessions through a simple, elegant interface with automatic memory decay.

## What is Lemma?

Lemma acts as an external hippocampus for AI assistants. The human brain does not record everything — it synthesizes, distills, and leaves behind fragments. Frequently accessed knowledge grows stronger; unused knowledge fades and is forgotten.

Lemma operates on the same principle:

- **Raw conversations are never stored** — only synthesized fragments
- **Fragments decay over time** — frequently accessed ones strengthen
- **The LLM reads fragments at every session** and remembers who it is

## How It Works

### Memory Structure

Each memory fragment has:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (format: `m` + 6 hex chars) |
| `title` | string | Short title for quick scanning |
| `fragment` | string | Synthesized memory text |
| `project` | string | Project scope (`null` for global) |
| `confidence` | float | Reliability 0.0-1.0 (decays over time) |
| `source` | string | `"user"` or `"ai"` |
| `created` | string | Creation date (YYYY-MM-DD) |
| `lastAccessed` | string | ISO timestamp of last read |
| `accessed` | int | Access count in current decay cycle |

### Decay Mechanism

Decay is applied every time memory is read. Unlike static memory, Lemma uses a biological model where frequency of access strengthens the memory, while time elapsed since last access weakens it:

```
modifier = max(0.005, 0.05 - (accessed * 0.005))
time_multiplier = 1 + (days_since_last_access * 0.05)
decay_step = modifier * time_multiplier
confidence = confidence - decay_step
```

- **Frequency**: Frequently accessed items reach a minimum decay rate.
- **Recency**: Items not accessed for a long time decay faster due to the `time_multiplier`.
- **Cleanup**: Fragments with **confidence < 0.1** are automatically purged.

### Memory File Location

Memories are stored in JSONL format at:

| OS | Path |
|---|---|
| **Windows** | `C:\Users\{username}\.lemma\memory.jsonl` |
| **macOS** | `/Users/{username}/.lemma/memory.jsonl` |
| **Linux** | `/home/{username}/.lemma/memory.jsonl` |

## Quick Start (No Installation Required)

The easiest way to use Lemma is to run it directly from GitHub using `npx`. You don't even need to download the repository!

Add this to your MCP client configuration:

**Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`  
**Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lemma": {
      "command": "npx",
      "args": ["-y", "github:xenitV1/lemma"]
    }
  }
}
```

---

## 🚀 Manual Installation (For Developers)

If you want to modify Lemma or run it locally:

```bash
git clone https://github.com/xenitV1/lemma
cd Lemma
npm install
```

### Requirements

- Node.js 18.0.0 or higher

### Local Configuration

If you have cloned the repository locally, use this configuration:

```json
{
  "mcpServers": {
    "lemma": {
      "command": "node",
      "args": ["C:\\path\\to\\your\\Lemma\\memory.js"]
    }
  }
}
```

**Manual configuration** (if needed):

```
# Lemma — Persistent Memory System

This is your persistent memory layer. It works like the human brain:
only important fragments are kept, frequently accessed ones grow stronger,
unused ones fade away.

RULES FOR WRITING TO MEMORY:
1. If the user explicitly asks to remember something → store it. source: "user"
2. If you notice something important on your own → store it. source: "ai"
3. Write the synthesized essence, not raw data. One sentence is enough.
4. Do not store everything. Only store what genuinely matters.
5. If a new fragment conflicts with an existing one → use update, not add.
6. If the user asks to forget something → use forget.

READING FROM MEMORY:
- Use the fragments provided when they are relevant to the current context.
- Trust fragments with confidence below 0.3 less.
- You do not need to mention the fragments explicitly; just let them inform your behavior.

At the start of each session: Call memory_read to load stored fragments.
```

## Available Tools

Read and return formatted memory fragments for LLM consumption. Applies confidence decay, limits to top-K, and reformats for optimum context.

**Parameters:**
- `project` (string, optional): Project name to filter (defaults to current project).
- `query` (string, optional): Semantic search keyword to find specific context.

**Returns:** Formatted string with confidence bars:

```
=== LEMMA MEMORY FRAGMENTS ===
[m1a2b3] █████ (🤖 ai) Communication style
    User prefers short and direct answers
[m4c5d6] █████ (👤 user) Project stack
    Project is TypeScript, Node 20
==============================
```

### `memory_check`

**MANDATORY:** Call this BEFORE any analysis, research, or document reading. Checks if project/topic already exists in memory. Prevents redundant work.

**Parameters:**
- `project` (string, optional): Project name to check (defaults to current project).

### `memory_add`

Add a new memory fragment.

**Parameters:**
- `fragment` (string, required): The memory text to store
- `title` (string, optional): Short title (auto-generated from first 40 chars if not provided)
- `source` (string, optional): "user" or "ai", default "ai"

**Example:**
```json
{
  "fragment": "User prefers dark mode in all applications",
  "title": "Dark mode preference",
  "source": "ai"
}
```

### `memory_update`

Update an existing memory fragment.

**Parameters:**
- `id` (string, required): The fragment ID to update
- `title` (string, optional): New title text
- `fragment` (string, optional): New fragment text
- `confidence` (number, optional): New confidence 0.0-1.0

**Example:**
```json
{
  "id": "m1a2b3",
  "title": "Updated title",
  "fragment": "Updated information",
  "confidence": 0.9
}
```

### `memory_forget`

Remove a memory fragment.

**Parameters:**
- `id` (string, required): The fragment ID to remove

### `memory_list`

List all memory fragments in JSON format.

**Parameters:** None

**Returns:** JSON array of all fragments

## Philosophy

### What Should Be Stored

**User Layer:**
- User preferences (communication style, format, language)
- Project context (technology stack, folder structure, conventions)
- Explicitly requested memories

**Capability Layer:**
- Successful solutions and approaches used
- Shortcuts discovered for recurring tasks
- Approaches that were tried and failed
- Task types and their best-fit strategy patterns

### What Should NOT Be Stored

- Raw conversation content
- One-off questions that won't recur
- Temporary or highly context-specific information
- Personal or sensitive data

## Development

### Running Tests

```bash
npm test
```

### Project Structure

```
Lemma/
├── memory.js       # Main MCP server implementation
├── memory-core.js  # Core memory logic (load, save, decay)
├── test.js         # Test suite
├── package.json    # Dependencies and metadata
├── README.md       # This file
└── .gitignore      # Git ignore rules
```

## Security

`memory.jsonl` is a local file and is never sent anywhere. Users can inspect its contents or clear it at any time via the MCP tools.

## License

MIT License
