---
'mastracode': patch
---

Fixed model discovery for OpenAI Codex accounts. `mastracode info --json` reads the cached account catalog without network access. Refresh it explicitly with `mastracode catalog refresh --provider openai-codex --json`. Models absent from that catalog are not offered as available, and native fallback selections retain the selected model.
