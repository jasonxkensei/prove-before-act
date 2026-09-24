---
name: MultiversX UI global CSS collisions
description: Why critical responsive visibility must not rely on generic Tailwind display utilities when the MultiversX UI runtime is active.
---

The MultiversX UI runtime can inject a Tailwind stylesheet after the application's
compiled CSS. Its unscoped utility selectors, including `.hidden`, can override
responsive display utilities from the application because they appear later in
the cascade.

**Why:** This caused the public desktop header navigation to remain hidden even
though the application's `md:flex` media rule matched and the menu existed in
the DOM.

**How to apply:** For critical responsive visibility around MultiversX-enabled
surfaces, use a project-specific class with an explicit media query rather than
combining generic `hidden` with a responsive display utility. Test with a
late-injected `.hidden { display: none }` rule to reproduce the production
cascade.