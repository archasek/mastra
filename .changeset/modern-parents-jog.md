---
'@mastra/code-sdk': patch
'@mastra/core': patch
---

Fixed model catalog refreshes changing installed runtime files. Mastra Code now reads and refreshes its user cache without modifying the installed release.
