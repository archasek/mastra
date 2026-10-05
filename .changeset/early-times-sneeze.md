---
'@mastra/code-sdk': patch
---

Fixed image history replay, removal of released thread lock markers, and duplicate choices in client questions.

Reject experimental durable and evented agent selections in ACP sessions before acquiring runtime resources. The regular native agent remains supported; ordinary SDK and terminal selections are unchanged.
