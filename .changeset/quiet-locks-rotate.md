---
'@mastra/code-sdk': major
---

Serialize auth.json account and credential mutations across processes, protect forced Codex token refreshes from refresh-token reuse, and acquire thread write locks atomically. AuthStorage mutation methods now return promises and must be awaited.
