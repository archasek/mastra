---
'@mastra/code-sdk': patch
---

Fixed OpenAI Codex model availability to use a dated catalog for the signed-in account. Saved sessions and background model requests retain their authentication route instead of falling back to an API key after sign-out. Bounded credential refresh preserves successful token updates before cleanup completes.
