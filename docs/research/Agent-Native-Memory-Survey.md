# Are We Ready For An Agent-Native Memory System?

> **Source:** Zhou, Zhou, Han, Xu, Li, Li, Xiong, Wu. *"Are We Ready For An Agent-Native Memory System?"* arXiv:2606.24775v1 [cs.CL], 23 Jun 2026.
> **Affiliations:** Shanghai Jiao Tong University, Tsinghua University, MemTensor (Shanghai).
> **Code/benchmarks:** https://github.com/OpenDataBox/MemoryData
> **Evaluates:** 12 representative memory systems + 2 reference baselines across 5 benchmark workloads / 11 datasets.

This is a data-management-perspective survey+benchmark of LLM-agent memory systems. It decomposes every agent-memory system into **four core modules**, builds a taxonomy, then benchmarks the field against six research questions. Lemma's own four-module shape (representation → extraction → retrieval → maintenance) maps closely onto this framework, which is why this paper is read here as a **design guide, not a blocker.**

---

## 1. The Core Question

Existing benchmarks evaluate agent memory mainly through end-to-end task-success metrics (F1, BLEU) while treating the underlying system as a **monolithic black box**. Critical system-level concerns — operational costs, architectural trade-offs, robustness under dynamic knowledge updates — stay insufficiently explored.

The paper proposes an **analytical framework** that decomposes agent memory into four core modules, then asks: *Are we ready for an agent-native memory system?*

### The six research questions (RQ1–RQ6)

| # | Question | One-line answer |
|---|----------|-----------------|
| RQ1 | Are memory systems effective across different agent workloads? | **No single architecture dominates.** Effectiveness depends on how well the memory structure aligns with the workload bottleneck. |
| RQ2 | How accurately do systems retrieve stored evidence? | Robustness comes from **preserving the right evidence at the right level of abstraction**, not from one universal memory form. |
| RQ3 | Are systems robust under dynamic updates? | **Graph-based methods handle updates most reliably;** append-only / fact-extraction stores struggle with targeted overwrites → "hallucinations of the past". |
| RQ4 | Do systems stay stable over long horizons? | **Append-only stores suffer catastrophic degradation** as evidence becomes distant. Standard semantic consolidation often **destroys chronological cues.** |
| RQ5 | What are the operational costs? | **Highly structured systems incur orders-of-magnitude higher index/latency cost** without proportional accuracy gains. |
| RQ6 | When do individual components go wrong? | Each abstraction layer (compression, summarization, fact extraction) **progressively discards information**; aggressive LLM extraction gains precision but **degrades multi-hop reasoning.** |

---

## 2. The Four-Module Taxonomy

Every memory system is decomposed into: **(1) Representation & Storage → (2) Extraction → (3) Retrieval/Routing → (4) Maintenance.** Each module has sub-categories ranked ❶ (lightest) → ❸/❺ (richest).

### 2.1 Memory Representation & Storage

| Logical representation | Physical storage |
|---|---|
| ❶ **Token-Level Sequence** — raw token stream (MemoChat, MEM1, MemAgent) | ❶ **Transient In-Context Register** — KV cache only, zero disk I/O (MEM1, MemAgent) |
| ❷ **Graph & Tree-Based Topology** — entities + relations (Mem0, MemoryBank, Zep) | ❷ **Specialized Single-Engine** — one substrate: vector DB / graph DB / keyword (Mem0, Zep, LightMem) |
| ❸ **Heterogeneous Composite** — schema-constrained structured objects across substrates (A-MEM, MemoryOS, MemTree) | ❸ **Heterogeneous Multi-Engine** — vector + graph + SQL indexes together (A-MEM, MemoryOS, MemTree) |

### 2.2 Memory Extraction

| Strategy | Trade-off |
|---|---|
| ❶ **Raw Sequence Concatenation** — store verbatim, no processing | Minimal compute; maximal info retention; poor precision at scale |
| ❷ **Schema-Free Semantic Extraction** — LLM extracts free-form facts (Mem0, Zep) | Good precision; loses structure/order |
| ❸ **Schema-Constrained Structured Extraction** — entities/relations into predefined schema (A-MEM, MemoryOS, Cognee) | Best for graph reasoning; heaviest extraction cost |

### 2.3 Memory Retrieval / Query Routing

| Strategy | Trade-off |
|---|---|
| ❶ **Native Attention-Based Retrieval** — rely on LLM context window directly | No external index; doesn't scale beyond context |
| ❷ **Semantic-Based Dense Retrieval** — vector embedding similarity | Standard; weak on temporal/order queries |
| ❸ **Topological Subgraph Traversal** — graph BFS/neighbor expansion (Mem0g, A-MEM) | Strong multi-hop; expensive |
| ❹ **Autonomous Agentic Routing** — LLM decides which store to query (A-MEM, Letta) | Flexible; adds latency + non-determinism |
| ❺ **Multi-Stage Hybrid Execution** — coarse filter → rerank → fuse (BM25 → KNN → graph) | Best precision; most complex |

### 2.4 Memory Maintenance (lifecycle governance)

| Strategy | Trade-off |
|---|---|
| ❶ **Timestamp-Based Multi-Versioning** — keep versions over time | Preserves history; storage grows |
| ❷ **Capacity-Driven Physical Eviction** — FIFO / token-limit / score-based pruning (MEM1, Letta, MemAgent) | Bounds storage; risks losing evidence |
| ❸ **LLM-Driven Semantic Consolidation** — LLM merges conflicts, abstracts redundancy into dense summaries (SimpleMem, MemTree) | **Best default** per the paper; destroys chronological cues if aggressive |

> Two eviction sub-styles: **Constraint-Based Hard Eviction** (deterministic FIFO/token limits) vs **Score-Based Priority Eviction** (temporal-decay × access-frequency, e.g. MemoryOS "Heat" score).

---

## 3. Key Findings (design-relevant detail)

### O1 — Cross-Workload Effectiveness
No single memory system dominates all workloads. The **leading system shifts per workload**:
- **Structure-aware systems** win LongMemEval (cross-session / temporal reasoning): Zep 48.0 LLM-Judge, Cognee 35.3 ROUGE-L F1.
- **Hybrid filtering** wins LoCoMo exactness: MemOS 11.5 EM.
- **Trace-preserving memory** wins DB-Bench (operation order / state changes): MemoChat 55.4 task-success.

**Robustness comes not from a single universal memory form, but from preserving the right evidence at the right level of abstraction before final matching.** MemoryOS and MemOS stay closest to the Pareto frontier across coverage.

### O2 — Beyond Exact Match
EM stays informative for canonical, directly-grounded outputs but degrades for multi-hop / temporal reasoning, where evidence must be recombined.

### O3 — Dynamic Update Robustness
- **Graph-based methods handle knowledge updates most reliably.**
- Popular fact-extraction plugins and append-only stores **struggle with targeted overwrites**.
- Systems lacking lifecycle management **return stale facts → "hallucinations of the past".**

### O4 — Long-Horizon Stability
- Many append-only stores suffer **catastrophic degradation** as evidence becomes distant.
- For time-dependent queries, **raw long-context still outperforms most memory-backed** approaches.
- **Standard semantic consolidation often destroys crucial chronological cues.**

### O5 — Operational Cost
- Highly structured systems incur **orders-of-magnitude higher index-construction time and query latency** than lightweight stores.
- Yet they do **not consistently deliver proportional accuracy gains.**
- **Localized maintenance is more cost-efficient than global reorganization.**

### O6 — When Individual Components Go Wrong
- Each layer of abstraction (compression, summarization, fact extraction) **progressively discards information.**
- Fine-grained LLM-based extraction yields **modest precision gains but substantially degrades multi-hop reasoning.**
- **Conservative memory consolidation is the best default maintenance strategy.**
- **Delayed flushing creates a deceptive trade-off** between surface-level coverage and actual answerability.

---

## 4. Systems Evaluated (representative set)

Mem0, Mem0g, Zep, MemTree, LightMem, SimpleMem, MemoryOS, A-MEM, Letta, MemoChat, MEM1, MemAgent — against **Long Context** and **Embedding RAG** baselines, across LoCoMo (long-conversation QA), LongMemEval / MemoryAgentBench (multi-session), and DB-Bench / LifeLongAgentBench (procedural execution).

---

## 5. Implications for an Agent-Native Memory System

The paper closes by identifying promising directions toward *truly* agent-native memory:

1. **Match the memory structure to the workload** — don't chase one universal form; choose representation by whether the bottleneck is temporal aggregation, exact grounding, or operation-order preservation.
2. **Prefer conservative consolidation** — aggressive semantic compaction trades recall + chronology for storage neatness. Keep versions where chronology matters.
3. **Invest in lifecycle management** — without explicit update/eviction, systems decay into stale-fact hallucinations. Graph structure or versioning handles dynamic updates best.
4. **Watch the cost cliff** — rich multi-engine systems pay orders-of-magnitude more latency for marginal accuracy. Localized maintenance >> global reorg.
5. **Mind the abstraction ladder** — every extraction/summarization step throws information away. Preserve raw traces where multi-hop reasoning is expected.
