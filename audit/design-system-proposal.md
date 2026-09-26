# ProveBeforeAct design direction and proposed system

## Direction: accountable infrastructure

The recommended direction combines:

- **Dark operational surfaces** for live systems, actions, telemetry, and developer tooling.
- **Restrained paper evidence surfaces** for specifications, proofs, commitments, and case-file details.
- **Editorial confidence** through scale, whitespace, and short declarative copy.
- **Verification semantics** where color and emphasis communicate evidence state rather than decoration.

The visual reference is institutional infrastructure with an archival evidence layer—not a generic AI product, crypto dashboard, or neon developer tool.

## Design principles

1. **Evidence is the product.** The proof artifact receives the strongest visual treatment.
2. **One dominant message per viewport.** Supporting claims step down clearly.
3. **Meaning before protocol.** Explain the user outcome before implementation vocabulary.
4. **Status is semantic.** Green means verified or the primary action, not ambient futurism.
5. **Density is deliberate.** Operational pages may be dense, but priority remains obvious.
6. **Documents and operations are related modes.** They share spacing, typography, state, and interaction rules.
7. **No chain-of-thought.** Public language uses “declared decision basis” or “declared justification”.

## Foundations

### Color roles

| Role | Proposed use |
| --- | --- |
| Operational canvas | Near-black green-neutral background |
| Elevated operational surface | Slightly lighter solid surface; no default glass effect |
| Evidence paper | Warm, low-glare off-white |
| Primary / verified | Clear mint green |
| Recorded / neutral | Neutral ink plus explicit label |
| Pending / review | Amber with text/icon |
| Failed / contested | Red with text/icon |
| Borders | Low-contrast structural lines |
| Muted text | Accessible gray-green, never used for critical status |

Green should appear on primary actions, verified state, active focus, and key protocol invariants. It should not be used as a background glow across every section.

### Typography

- **UI and body:** a neutral grotesk with excellent small-size legibility.
- **Editorial accent:** a restrained serif used only for category-defining statements and evidence/document emphasis.
- **Monospace:** hashes, proof IDs, timestamps, code, equations, and protocol labels only.
- **Scale:** large category headline; compact but readable operational labels; body copy with generous line height.

Prototype candidates:

- DM Sans for interface/body.
- Instrument Serif for limited editorial emphasis.
- DM Mono for evidence and protocol details.

Production implementation should bundle approved font files or use the existing loading strategy without introducing blocking imports.

### Spacing and layout

- Base spacing unit: 4 px.
- Primary rhythm: 8, 12, 16, 24, 32, 48, 72, 96.
- Text measure: approximately 60–72 characters for explanatory copy.
- Full-page sections use fewer, larger spatial transitions rather than many bordered strips.
- Mobile uses the same hierarchy, not a compressed desktop grid.

### Shape and depth

- Small, consistent corner radius for controls and operational surfaces.
- Evidence paper may use square or nearly square corners.
- Shadows are reserved for physical/document layering, not every card.
- Borders separate information only when hierarchy or state requires them.

## Core components

### Public navigation

- Stable brand area.
- Intent-based destinations: understand, verify, build.
- One primary CTA.
- Keyboard-accessible “More” and mobile menu.
- Same link destinations, test hooks, connect behavior, and language behavior as production.

### Evidence case file

Canonical internal order:

`claim → declared decision basis → commitment timestamp → actor/issuer → independent verification → outcome`

Required state distinctions:

- **Recorded:** evidence exists.
- **Verified:** independent check succeeded.
- **Outcome recorded:** post-action evidence exists.
- **Pending / contested / failed:** explicit label, icon, and explanatory text.

### Buttons and links

- Primary filled action.
- Secondary outlined action.
- Tertiary text link.
- Destructive and irreversible actions are visually distinct and require existing confirmation behavior.
- Minimum 44 px target size for primary mobile controls.

### Cards and panels

Use a panel only for one of four reasons:

1. It is independently actionable.
2. It has a distinct status.
3. It is a reusable evidence artifact.
4. It needs containment for dense data or code.

Avoid turning every paragraph or feature into a card.

### Code and hashes

- Dedicated monospace treatment.
- Copy control with accessible label and live confirmation.
- Horizontal scrolling contained within the block.
- Plain-language result adjacent to the example.

### Forms and asynchronous states

- Persistent labels; placeholders are examples, not labels.
- Focus, error, pending, success, and disabled states are explicit.
- Wallet, upload, payment, and blockchain progress keep their current business semantics.
- Async success must not be conflated with blockchain verification.

## Homepage redesign rationale

The proposed homepage concept reorganizes the existing content around a simpler narrative:

1. **Category thesis:** accountability starts before the action.
2. **Concrete proof artifact:** the user immediately sees what is committed and what can be verified.
3. **Invariant:** `T(intent_proof) < T(action)`.
4. **Canonical loop:** `OBSERVE → DECIDE → PROVE → ACT → PROVE`.
5. **Pattern versus implementation:** Prove Before Act is the open pattern; xProof is the reference implementation.
6. **Adoption:** quick-start code and a free-key path.
7. **Applicability:** use cases and integration context.
8. **Commercial clarity:** simple pricing.
9. **Objection handling:** focused FAQ.

The concept deliberately removes the current hero’s competing badges and promises. It uses one paper case file as the primary visual rather than decorative AI/Web3 imagery.

## Responsive behavior

- Desktop uses a thesis/evidence split.
- Mobile presents thesis, actions, invariant, then evidence in one linear sequence.
- Navigation collapses to a menu while the primary CTA remains visible.
- Buttons become full width where useful.
- Evidence rows stack labels above values.
- Code, equations, and hashes remain contained.

## Approval gate

This document and the linked responsive prototype define direction only. Production implementation must not begin until the direction is explicitly approved. The already-scoped implementation task should then translate these tokens and components into the existing codebase while preserving every integration-sensitive zone listed in the audit.
