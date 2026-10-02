---
'@mastra/core': minor
---

Added an opt-in `requireExistingThread` setting for local agent controllers. When enabled, loading a saved thread fails instead of silently creating a new one if that thread does not exist in the selected workspace.

```ts
await bootLocalAgentController({ cwd: '/workspace', initialThreadId: 'saved-thread', requireExistingThread: true });
```
