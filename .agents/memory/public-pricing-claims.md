---
name: Public pricing claims
description: Rules for presenting mutable certification prices across public web, agent, and published-skill surfaces.
---

Public pricing must be read from the live pricing endpoint or explicitly direct readers to `/api/pricing`; do not present fallback amounts as enduring product facts. This applies equally to React pages, crawler/server-rendered pages, generated agent discovery responses, documentation, and the published ClawHub bundle.

**Why:** A current live amount can coincidentally equal a former fixed price. Without explicit live-rate wording, users and agents cannot distinguish a runtime value from a stale commercial claim; crawler-rendered variants are separate public surfaces and can otherwise drift from the browser app.

**How to apply:** When adding a price to external prose, either derive it from the pricing service and label it “current live rate,” or link to `/api/pricing`. Use a nonnumeric loading/unavailable fallback. Add the source to the public-branding regression guard, and republish the matching ClawHub compatibility copies after changing a bundle file.