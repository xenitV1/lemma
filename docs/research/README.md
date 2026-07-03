# Research & References

Academic papers and research documents that influenced and continue to guide Lemma's development.

## Agent Memory Systems (Survey & Benchmark)

- **[Are We Ready For An Agent-Native Memory System?](./Agent-Native-Memory-Survey.md)** — Data-management survey that decomposes agent memory into four modules (representation/storage, extraction, retrieval/routing, maintenance) and benchmarks 12 systems across 5 workloads. Key guides for Lemma: (1) no single architecture dominates — match structure to workload; (2) graph/versioned structure handles dynamic updates best while append-only stores decay into "hallucinations of the past"; (3) conservative consolidation beats aggressive compaction because it preserves chronological cues; (4) localized maintenance is far cheaper than global reorg; (5) every extraction/summarization layer discards information, so preserve raw traces where multi-hop reasoning is expected. Read as a design guide for the roadmap (temporal/versioned memory, working-memory buffer, lifecycle cost), not a blocker.

## Memory & Continual Learning

- **[Self-Distillation Enables Continual Learning](./Self-Distillation%20Enables%20Continual%20Learning.md)** — Core inspiration for Lemma's guide distillation system (`guide_distill`). Raw memory fragments are compressed into reusable procedural knowledge, mirroring self-distillation in neural networks.
- **[AgeMem: Agentic Memory Framework](./AgeMem-Agentic-Memory-Framework.md)** — Informed the biological memory model (confidence decay, access-based reinforcement, negative feedback). Lemma's `decayConfidence` / `boostOnAccess` / `recordNegativeHit` cycle directly reflects this research.

## Self-Refinement & Iterative Improvement

- **[Self-Refine: Iterative Refinement with Self-Feedback](./Self-Refine_-Iterative-Refinement-with-Self-Feedback.txt)** — Basis for the feedback loop where LLMs evaluate and improve their own outputs. Relevant to `memory_feedback` (positive/negative) and guide improvement suggestions.
- **[Learning to Refine: Self-Refinement of Parallel Reasoning](./Learning%20to%20Refine_%20Self-Refinement%20of%20Parallel%20Reasoning%20in%20LLMs.txt)** — Parallel reasoning patterns informed multi-fragment association tracking (`trackAssociations`).
- **[SSR: Socratic Self-Refine for LLM Reasoning](./SSR_%20Socratic%20Self-Refine%20for%20Large%20Language%20Model%20Reasoning.txt)** — Question-driven self-improvement inspired the audit system (`memory_audit`) that identifies gaps and contradictions.
- **[Enhancing LLM Planning through Intrinsic Self-Critique](./Enhancing%20LLM%20Planning%20Capabilities%20through%20Intrinsic%20Self-Critique.txt)** — Self-critique mechanisms informed session outcome tracking and guide success rate analysis.
- **[Evolving LLMs' Self-Refinement via Synergistic Training-Inference](./Evolving%20LLMs%20Self-Refinement%20Capability%20via%20Synergistic%20Training-Inference%20Optimization.txt)** — Synergy between training and inference optimization informed the dual-path memory system (static facts via memories + procedural skills via guides).

## LLM Inference & Improvement

- **[A Survey on LLM Inference-Time Self-Improvement](./A%20Survey%20on%20LLM%20Inference-Time%20Self-Improvement.txt)** — Comprehensive survey covering techniques that informed the overall architecture of persistent memory as an inference-time enhancement.
- **[2603.19461v1](./2603.19461v1.txt)** — Additional research on LLM capability enhancement during inference.

## Architecture References

- **[llm-wiki](./llm-wiki.md)** — Karpathy's LLM Wiki pattern. Inspired `memory_audit` (wiki health-check), universal memory injection (always-available knowledge), and the 3-layer injection architecture.
- **[llm-wiki-v2](./llm-wiki-v2.md)** — LLM Wiki v2 by [@rohitg00](https://github.com/rohitg00). Extended patterns from production experience that inspired v0.8.1: privacy filtering, typed relations, topic overlap detection, injection ranking, smart session start, and query filters.
- **[self-improvement-architecture](./self-improvement-architecture.md)** — Internal design notes mapping research concepts to Lemma's implementation.

## How These Relate to Lemma

| Research Concept | Lemma Implementation |
|---|---|
| Self-distillation | `guide_distill` — memory fragment → guide learning |
| Memory decay | `decayConfidence` — biological forgetting curve |
| Access-based reinforcement | `boostOnAccess` — confidence +0.015 on use |
| Negative feedback | `recordNegativeHit` — confidence -0.02 |
| Association tracking | `trackAssociations` — bidirectional cross-references |
| Self-critique / audit | `memory_audit` — orphan detection, anomaly detection |
| Knowledge compounding | `guide_merge` / `memory_merge` — consolidation |
| Always-available knowledge | Universal tool description injection |
| Session-based learning | `session_start` / `session_end` + virtual sessions |
| Privacy governance | `privacy.ts` — 17 regex patterns, auto-redact on ingest |
| Typed relations (v2) | `memory_relate` — contradicts, supersedes, supports, related_to |
| Contradiction detection (v2) | `findTopicOverlaps` — 40-65% similarity range suggestions |
| Lifecycle injection (v2) | Composite ranking — confidence × recency |
| Smart context loading (v2) | `session_start` pre-loads top-3 relevant memories |
