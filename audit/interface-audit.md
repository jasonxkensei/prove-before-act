# ProveBeforeAct interface audit

## Scope

Read-only audit of the current public, authenticated, evidence, fleet, documentation, and administrative interfaces. No production interface, API, integration, route, or business logic was changed.

## Executive summary

ProveBeforeAct already contains the substance of a credible accountability product: a public standard, real proof artifacts, agent profiles, operational flows, and a reference implementation. The main design problem is not missing content. It is that too many elements ask for equal attention.

The current interface often presents headings, badges, cards, borders, status colors, explanatory copy, and calls to action at similar intensity. This makes a rich product feel closer to a developer prototype than premium infrastructure. The recommended direction is to make evidence—not decoration—the dominant visual object.

## UX audit

### Route families and user journeys

1. **Discovery and adoption**
   - `/`, `/learn`, `/founder`, localized and legal pages.
   - The homepage currently serves several jobs simultaneously: explain the category, register an agent, verify a file, promote the standard, explain x402, show pricing, and provide code.

2. **Standard and technical understanding**
   - `/standard`, `/docs`, technical guides, agent context, coherence documentation.
   - These pages need strong reading hierarchy, orientation, copyable examples, and progressive disclosure rather than marketing density.

3. **Public evidence and accountability**
   - Proof, audit, attestation, incident, issuer, agent profile, calibration, comparison, and leaderboard routes.
   - These are externally shareable accountability artifacts. Their canonical URLs and status semantics are product contracts.

4. **Authenticated operations**
   - Dashboard, certification, and settings.
   - The operator needs current status and the next required action before onboarding education or secondary configuration.

5. **Fleet and administration**
   - Fleet inspection/management, public metrics, and protected administration.
   - These surfaces need explicit operational priority: health/status, primary action, filters, then dense detail.

### Priority findings

#### P0 — preserve trust and integration contracts

- Do not change route/auth boundaries, redirects, canonical public evidence URLs, or the intentionally public `/stats` behavior.
- Preserve all registration, proof, certification, signed fleet, admin, wallet, telemetry, copy, upload, and verification wiring.
- Never style a pending or partially confirmed item as verified.
- Resolve the theme contract before production implementation: dark operational surfaces and paper/document surfaces should be explicit modes, not competing global overrides.

#### P1 — hierarchy and comprehension

- **Homepage:** reduce competing above-fold messages to one thesis, one primary adoption action, one secondary understanding action, and one concrete proof artifact.
- **Navigation:** group destinations by intent—understand, verify, build—while retaining every existing destination and test hook.
- **Dashboard:** lead with operational state and next action; keep onboarding resumable but secondary.
- **Documentation:** add orientation, table-of-contents behavior, plain-language outcomes, and progressive disclosure without removing technical depth.
- **Fleet/admin:** establish page title → health/status → primary action → filters → detail.

#### P2 — consistency, responsive behavior, and accessibility

- Standardize mobile navigation, touch targets, focus visibility, selected states, and async announcements.
- Pair every status color with text and/or an icon.
- Reserve green for successful verification and primary action; use amber for pending/review and red for failed/contested.
- Reduce repeated pills, translucent headers, card grids, hover elevation, and ambient green accents.
- Ensure hashes and code scroll within their own containers rather than causing page overflow.

## Visual audit

### What is working

- The black/green identity is recognizable.
- The paper treatment on the standard creates useful separation from operational surfaces.
- Monospace details communicate technical evidence well when used selectively.
- Real proof, transaction, and integration content gives the product credibility.

### What weakens the premium perception

- Repeated borders, badges, cards, and micro-labels create uniform visual intensity.
- Green is used both as brand atmosphere and status, weakening its meaning.
- Several header conventions make the product feel assembled page-by-page.
- Dense marketing and technical copy compete instead of unfolding in a deliberate sequence.
- Decorative “tech” treatments occasionally compete with the evidence itself.

## Integration-sensitive zones for implementation

- Route order, auth split, redirects, and public/protected boundaries.
- Public header links, menu destinations, language behavior, connect callbacks, and existing test IDs.
- Homepage agent registration, API-key handling, proof creation, verify URLs, quick-start tabs/copy, and conversion tracking.
- Dashboard certification queries, onboarding persistence, badge snippets, proof links, and status labels.
- Certification upload/drop-zone semantics and every blockchain transaction/result state.
- Fleet signing and management controls.
- Administrative selections and operations.
- Public hashes, timestamps, transaction links, explorer links, proof IDs, and status language.

## Recommended product principle

Every accountability surface should answer, in order:

1. What was claimed?
2. What declared decision basis was committed?
3. Was the commitment made before the action?
4. Who acted and who issued the proof?
5. What can be independently verified?
6. What outcome was recorded?

This is the durable hierarchy for the homepage proof artifact, proof pages, audits, profiles, fleet views, and future operational surfaces.
