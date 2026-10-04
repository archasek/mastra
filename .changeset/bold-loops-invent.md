---
'mastracode': patch
---

Fixed structured error responses when the authentication store cannot be opened.

Fixed thread lock release ordering when the terminal application exits. Thread ownership is retained until runtime shutdown and storage cleanup complete, with synchronous cleanup for forced exits.
