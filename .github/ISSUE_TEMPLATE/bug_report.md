---
name: Bug report
about: Something returned the wrong value, threw the wrong error, or failed a documented guarantee
labels: bug
---

**Version**

The `version` in `node_modules/@tomnio/rubric/package.json`, or the commit if running from source.

**Provider and mode**

Which SDK you wrapped (`openai` / `@anthropic-ai/sdk` / `@google/genai` / a gateway with `baseURL`), and the `mode` if you set one.

**Schema and input**

The smallest Zod schema and input that reproduce it. Error objects are designed to be dumped — paste the full error, including `issues`, `attempts`, and `usage` fields where present.

**Expected behavior**

What the README or `docs/` says should happen, and the page or section you read it from.

**What happened instead**

```
Paste the error output or the wrong value here.
```
