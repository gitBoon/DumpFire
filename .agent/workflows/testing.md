---
description: Testing policy - browser testing is user-only
---

# Testing Policy

**Do NOT use the browser subagent for testing.** The user will test in the browser themselves.

When verification is needed:
1. Run `npm run build` to check for type/compile errors
2. Describe to the user what to test manually
3. Wait for the user to report results

Never attempt to open, navigate, or interact with the browser on behalf of the user.
