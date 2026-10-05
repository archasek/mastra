---
'@mastra/code-sdk': patch
---

Fixed image history replay, removal of released thread lock markers, and duplicate choices in client questions.

Reject experimental durable and evented agent selections in ACP sessions before acquiring runtime resources. The regular native agent remains supported; ordinary SDK and terminal selections are unchanged.

Choose an available authenticated model for new ACP sessions when the previous provider is not configured. Require authentication before restoring a saved conversation whose selected provider is no longer configured, without changing its model or losing live events during discovery.
