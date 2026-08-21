---
name: PBA positioning and adoption
description: Strategic direction for presenting Prove Before Act as a pre-execution accountability pattern and growing adoption beyond xProof.
---

# PBA positioning and adoption

Treat Prove Before Act as the accountability pattern for autonomous agents, with xProof as its reference implementation. File certification and on-chain anchoring are primitives and use cases, not the primary category identity.

**Why:** The strongest current product evidence is the testable temporal invariant that an independently verifiable representation of the intended action exists before execution. The market risk is no longer whether the primitive can be built; it is whether independent agents adopt the pattern.

**How to apply:** Lead public messaging with pre-execution evidence / commit-before-execution and the question “What did the agent commit to before it acted?”. Keep blockchain, files, certificates, and PDFs subordinate to that concept. Prioritize distribution and independent implementations over additional feature breadth; a meaningful milestone is ten third-party implementations, ideally across MCP, SDKs, frameworks, and non-xProof implementations.

# Terminology

Prefer “the agent’s decision basis (WHY)” over “the agent’s reasoning” in public and developer-facing copy. The former means declared decision, justification, context, and action without implying exposure of chain-of-thought.

**Why:** “Reasoning” can be interpreted as private chain-of-thought, while the mechanism only requires an auditable decision basis.

**How to apply:** Replace the phrase consistently across the homepage, agent pages, SDK/docs copy, and other public surfaces when editing messaging. Preserve the concrete sequence: observe → decide → prove → act → prove.

## Distribution-surface coverage

When updating PBA terminology, treat package READMEs, published legacy skill copies, public SDK tool docstrings, and framework examples as public integration surfaces—not just the primary website or task-listed documentation.

**Why:** Integrators often enter through an SDK or published skill. A stale reasoning-first quickstart can contradict the safe decision-basis model and invite private chain-of-thought disclosure even when the public site is correct.

**How to apply:** Search all distribution directories for developer-facing guidance and update terminology together. Preserve documented compatibility vocabulary, but explain it as declared decision-basis metadata rather than private reasoning.

## Hash-only documentation must be literal

When public guidance says a declared decision basis is hashed locally, request examples must send only the hash plus minimal, intentionally public classification metadata—not the basis object, its `why`/rationale, prompts, source lists, tickets, policy details, or a spread of the local object.

**Why:** Forwarding locally hashed content through `metadata` defeats the privacy claim and turns a copy-paste integration guide into a data-disclosure risk.

**How to apply:** Use opaque IDs and public categories in examples, and validate every language/version of public agent guidance for disclosure-safe request examples.