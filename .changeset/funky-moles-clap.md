---
'@mastra/code-sdk': minor
---

Added an ACP server for Mastra Code with per-checkout thread isolation, restored-session history replay, lifecycle-safe cleanup, and restricted HTTP MCP support. Remote MCP servers require HTTPS, malformed Codex OAuth state is reported as unknown, and device sign-in stops promptly when cancelled. Harnesses can pin the main and vector databases to private local files so project settings cannot redirect isolated sessions.

Fixed shutdown to drain notification delivery and active sessions before stopping workers and closing storage, including failed startup. User question answers retain their declared types, cancelled sign-in cannot save credentials after waiting for the auth lock, and reserved MCP server names are rejected.

Fixed thread ownership during shutdown and synchronous cleanup when a process exits. Lock acquisition preserves errors other than contention. Client-provided HTTP MCP servers cannot redirect requests or send their headers outside the validated origin.

Fixed failed shutdown cleanup to retain thread ownership until storage and transports close. Restored sessions accept new requests only after saved history finishes replaying.
