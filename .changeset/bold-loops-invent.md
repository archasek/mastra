---
'mastracode': patch
---

Fixed structured error responses when the authentication store cannot be opened.

Fixed thread lock release ordering when the terminal application exits. Thread ownership is retained until runtime shutdown and storage cleanup complete, with synchronous cleanup for forced exits.

Fixed ACP mode to leave signal-driven shutdown to its own runtime instead of exiting through terminal cleanup.

Wait for API key persistence before reporting successful sign-in or exiting, and report a failed write without claiming success.
