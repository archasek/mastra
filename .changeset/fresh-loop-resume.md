---
'@mastra/core': patch
---

Clear stale resume markers when an evented workflow starts a new normal loop iteration, so recovery uses that iteration's input instead of a previous resume payload. Preserve active resumed-step and nested-run recovery metadata.
