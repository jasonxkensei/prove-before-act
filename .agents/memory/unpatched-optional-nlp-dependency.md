---
name: Optional NLP dependency with no patch
description: Handling an upstream NLTK advisory in the optional LlamaIndex example when no fixed release exists.
---

An upstream NLTK model-artifact path-security advisory has no patched release available. The optional LlamaIndex example depends on NLTK transitively, while the main Python SDK does not require it. Do not claim this finding has been remediated by upgrading other dependencies, and do not silently remove the optional integration merely to clear a scanner result.

**Why:** The affected import/export APIs belong to NLTK and the project does not call them; removing LlamaIndex would break supported optional functionality without providing a fix for users who independently install it.

**How to apply:** Check for a genuine upstream patched release before changing the optional dependency. Until then, disclose the remaining advisory and avoid exposing NLTK model-file import/export paths to untrusted callers.