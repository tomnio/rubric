---
name: Feature request
about: A new mode, provider, guardrail, or document-pipeline behavior
labels: enhancement
---

**The problem it solves**

What you were trying to extract, and what stopped you. Concrete documents and schemas beat abstract descriptions.

**Which layer it belongs to**

- `create()` — one prompt, one schema (modes, guardrails, validation)
- `createDocument()` — long documents (chunking, merge, dedupe, conflicts)
- `@tomnio/rubric/pdf` — PDF → text
- something else

**Alternatives you considered**

What you do today instead of this feature — a workaround, a different library, or doing it by hand.

**Not in scope**

CLI, batch jobs, cache, and retrieval/RAG are confirmed non-goals for this library (see the README). If the request needs one of those, say why the non-goal should move.
