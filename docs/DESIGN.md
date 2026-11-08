# phonelink: blue porcelain

The phone is the instrument. The interface is its quiet workbench. This design replaces
console-v1; the historical HTML stays intact. Landing copy and section order stay intact.

## Palette

Light: Porcelain #F0F3F8 (canvas), Paper #FFFFFF (surface), Ink #202D42 (text),
Slate #56657A (secondary text), Cobalt #3159BF (action), Sea #26705C (safe/running).
Dark: Night blue #172338 (canvas), Deep blue #1D2D45 (surface), Chalk #E8EDF6 (text),
Mist #ADBCD1 (secondary text), Cornflower #A9BFFF (action), Glass #93D8BC (safe/running).
Additional semantic tokens cover borders, danger, warning, focus, device materials, and
shadows. All color literals live in globals.css. Dark uses blue surfaces with perceptible
layers; light uses cool porcelain with white work surfaces. Neither is an inversion.

## Typography

Public Sans, next/font/google, variable: body, controls, labels, numbers (tabular figures).
Replaces Manrope after the Round 4 small-text rendering comparison.
Sora, next/font/google, variable: brand and display headings. Its open geometric shapes
relate to rounded Android hardware. No display serif, no condensed tracked labels.
Code uses the system monospace stack only for commands, packages and Codespace names.
Minor-third scale (1.2): 12, 14.4, 17.3, 20.7, 24.9, 29.9, 35.8, 43, 51.6, 61.9.
Body 16–18; notes 13 minimum; controls 14; console heading 36; landing heading fluid 38–62. Line height
1.6 body, 1.14 display. Reading widths stay under 75 characters.

## Space, shape and elevation

Space: 4, 8, 12, 16, 24, 32, 48, 64, 96. Desktop content max 1200px; console 1120px.
Left aligned text. Device display centered within its work surface.
Radii: 6 code, 8 controls, 12 menus, 20 phone work surfaces, 38 device shell.
Status is a small dot plus plain text, not another outlined pill.
Only the phone and floating account menu cast shadows. Lists use spacing and separators.
No gradients. Phone wallpaper uses solid overlapping circular shapes, as a physical
screen design rather than an ambient page decoration.

## Wireframes

Landing desktop:
+ brand                 How / Limits / Pricing   Theme +
| A phone in your browser,      |                     |
| for every agent you run.      |                     |
| explanation / actions        |   [ PHONE ]         |
| agent compatibility          |                     |
+------------------------------+---------------------+
|                    live steps                     |
| Three steps / API / limits / pricing (same order)  |

Landing 390:
+ brand                          Theme +
| How / Limits / Pricing               |
| headline                            |
| copy / actions / agents             |
|             PHONE                   |
| log                                 |
| sections, stacked                   |

Dashboard desktop:
+ brand  Phones                    Theme   Account +
| Your phones                          New phone   |
| Two phones. Your own GitHub account.              |
| [screen] Phone A        | [screen] Phone B         |
|          running       |          stopped         |
|          metadata      |          metadata        |
|          open / stop   |          open / wake      |
| Example estimated usage   ========  GitHub        |
| Stop keeps your phone. Only delete erases it.     |

Dashboard 390:
+ brand                 Theme Account +
| Your phones             New phone   |
| explanation                         |
| [screen] Phone A / state / metadata  |
|          actions                    |
| [screen] Phone B / state / metadata  |
|          actions                    |
| usage / safety                      |
+ Phones                     Usage    +

Phone desktop:
+ brand / Phones / phone-id      state Theme Account +
|                        | Log  Apps  Backups Danger |
|       [ PHONE ]        | Activity / steps          |
|                        |                          |
|    device controls     | Details / backup          |
|    takeover            |                          |

Phone 390:
+ brand              Theme Account +
| Phones / phone-id / state         |
|           PHONE                  |
| controls / takeover              |
| Log Apps Backups Danger          |
| log or typed delete confirmation |
| details                          |

## Motion and the memorable thing

A cobalt screen with two oversized porcelain discs: the same device across marketing,
cards and the viewer. It is recognizable even at thumbnail size. No decorative gradients.
One word rotation on landing; honor reduced motion. No card entrance animation.
Controls respond in 150ms. Focus uses a solid offset outline, never a glow.

## Review before implementation

Rejected: lavender gradients and a row of telemetry cards. They could belong to any SaaS.
Replaced with solid device artwork and one restrained usage sentence/meter.
Rejected: serif editorial heading on cream. Chose cool blue porcelain and geometric Sora.
Removed: eyebrow labels, all-caps styling, neon, generic pills, arrow suffixes, stat strips.
Landing has legacy capitalized copy which must remain word-for-word; CSS presents those
labels in lowercase without altering their source text. Steps retain numbers because
Connect, Boot, Watch form an actual sequence. Code examples retain literal arrows.

## Inspiration inspected

- https://ui.justinlevine.me/docs — separate timestamps and readable log content.
- https://originui.com/ — native, compact theme choices and clear focus states.
- https://designspells.com/ — spend personality on one subject-specific detail.
No source code copied; no UI dependencies added.

## Screenshot critiques

Each review covers both themes and 390px, with all images opened for inspection.

### Round 1 — all 24 required screens inspected

Looked at landing, sign-in, dashboard, empty dashboard, log and danger in both themes
at 1440 and 390. Hierarchy and device artwork hold together. No horizontal overflow or
browser errors. Mobile header wrapped its account control into an accidental third row;
the bottom sticky navigation obscured a content row. Reordered header controls and gave
mobile navigation its own document space. Removed one accessory: the duplicate quota
badge in the header. Replaced duplicate state metadata with the safe-stop/resume message.
Added explicit disabled Stop/Wake controls, since Phase 2 has no lifecycle mutations yet.

### Round 2 — all 24 required screens inspected

Mobile navigation now clears the content and the header has a deliberate two-row layout.
The log has a clear timestamp column, and deletion reads as a separate caution area.
Removed one accessory: the second brand mark inside sign-in. Increased small mobile
comparison text, strengthened the confirmation field boundary, and stopped the viewer
background stretching to the height of a long log. Added specific apps/backups empty
messages and a designed resting-phone view instead of a bare placeholder.

### Round 3 — 62 final screenshots inspected

Opened all nine screens at 1440, 1024 and 390 in both themes, then account-menu and
keyboard-focus captures at 1440/390 in both themes. The phone, content column and type
hierarchy align across widths. Neither theme has horizontal overflow. Focus is visible
without moving the layout; menu contents fit mobile. Removed one accessory: the plus
symbol on the resting-phone illustration, which incorrectly implied adding a new phone.
Recaptured and inspected all six resting-phone views after that adjustment.

Secondary text is at least 4.75:1 on the three main surfaces; primary text exceeds 9.99:1.
Confirmation boundaries exceed 3.66:1 and focus exceeds 5.70:1 on main surfaces.
These are token-pair calculations, not a claim of a full automated accessibility audit.
Disabled controls and decorative device artwork are excluded from text/control thresholds.

## Implementation inventory

- `app/globals.css`: semantic color tokens, themes, focus, reduced motion.
- `app/layout.tsx`: Manrope/Sora, early theme selection before paint.
- `app/(marketing)/page.tsx`, `landing.module.css`, `rotating-word.tsx`,
  `scroll-button.tsx`: landing visual system, theme control, reduced-motion behavior.
- `app/login/page.tsx`: sign-in design and theme navigation.
- `app/(app)/layout.tsx`, `app/(app)/app/page.tsx`,
  `app/(app)/app/phones/[id]/page.tsx`: dashboard, mobile navigation and every detail tab.
- `components/console.module.css`, `components/interaction.module.css`: shared console
  visual systems. Both stay at the `components/` root because they serve several groups.
- `components/shell/theme-toggle.tsx`, `components/ui/copy-button.tsx`: theme persistence
  and clipboard feedback.
- `components/shell/topbar.tsx`, `components/phone/phone-card.tsx`,
  `components/phone/stage.tsx`, `components/ui/mini.tsx`, `components/ui/tabs.tsx`,
  `components/ui/log-feed.tsx`, `components/shell/quota-strip.tsx`,
  `components/ui/empty-state.tsx`, `components/phone/danger-panel.tsx`: navigation,
  account menu, devices, states and typed confirmation.
- `components/phone/`, `components/settings/`, `components/ui/`, `components/shell/`,
  `components/marketing/`: device lifecycle, settings forms, primitives, app chrome and
  the landing visual. Imports use the `@/components/...` alias.
- `lib/phones.ts`: presentation metadata only.
- `lib/session.ts`: `await connection()` before session reads so time-dependent expiry
  runs at request time. Session creation, expiry and cookie semantics are unchanged.
- `preview/redesign/`: final PNGs, measurement reports and screenshot index.

No dependencies added. No production database, OAuth scopes, auth routes, cookie settings,
DB schema, environment files or historical HTML changed. No commits.

## Final verification

`pnpm lint`, `pnpm test` (3/3) and `pnpm build` all pass in the isolated source copy.
Build generated all 10 pages with Cache Components enabled. Browser checks pass for
persisted/system theme, route protection, logout, tabs, typed confirmation and keyboard
focus. Dev portal has no Date.now prerender insight; dev console has no corresponding
error. Browser checks wait for hydration and completed navigation before interactions.
The final screenshot index contains 62 PNGs. Temporary design DB and tools were removed,
and the dev server on port 4321 was stopped. No connected OAuth flow or real phone
operations were exercised, as requested.


## Round 4 — lead review: type, availability and composition

**Cause of the apparent collapsed words.** The source contains ordinary spaces. Browser
DOM Range measurements reproduced the issue in a plain block with one text node, outside
flex layouts. The actual Latin Manrope font was loaded. Computed word/letter spacing
was normal. Turning tabular figures off produced identical space widths. At 12px,
Manrope's space advance rendered as just 2 CSS pixels in this headless Chromium; at
13px it was 3px. Arial's comparison was 3.34px / 3.63px respectively. Narrow spaces,
geometric letter shapes and undersized notes made word boundaries visually disappear;
this was not missing JSX whitespace or a flex text-node bug.

Replaced the body face with Public Sans (Sora remains the display face). The same
plain-text comparison gave 3px at 12px and 4px at 16px before adjustment. Raised the
affected interface notes, footer, table rows and captions to 13px; body is 16px, landing
lead 18px. A restrained .035em word-space adjustment reinforces boundaries in prose;
code retains normal word spacing. No font axes or numeric feature workaround is used.
Inspected actual footer/hero-note/permission/table crops at 200%, in both themes and all
three widths, as well as every full screenshot. The important safety sentences now read
as distinct words. Source copy on the landing remains unchanged.

**Composition and availability.** The landing hero is a two-column grid, with a 300 ×
600px phone in normal flow at 1440px; the live-steps panel follows after an 80px gap.
At 1024px the device becomes 260 × 520px; at 390px it stacks below the copy. Body
paragraphs, limits table and plan list are 16px on desktop. Notes are 13px. Creation has
an outlined, dashed unavailable state and an adjacent “Phone creation is coming soon.”
reason, connected with aria-describedby. Other disabled controls use the same material
and retain readable contrast; their title or description explains availability. Danger
retains its warning color and typed confirmation.

**Metadata and pairing.** Removed capitalization by CSS, supplied CPU and adb explicitly,
and rewrote console middle-dot metadata as “API 36 with Google APIs”, “Verified”, a
parenthesized APK size, and “Screenshot saved”. The stopped miniature uses a substantial
slate-blue screen with the same wallpaper forms as the running phone. State remains
explicit through the status dot and word.

**Remove one accessory.** Landing: removed the decorative clock glyph beside the takeover
sentence. Login: removed permission tick/minus glyphs; the sentences carry their meaning.
Dashboard: removed the redundant running-card top stripe, which repeated the status;
the empty dashboard also loses its duplicate unavailable creation button. Phone detail
(all tabs): removed the decorative date below the example device clock.

**Verification.** pnpm lint, pnpm test (3 tests), and pnpm build passed in the isolated
workspace using the unchanged dependency installation. No new dependencies. Replaced all
62 screenshots: landing, login, populated/empty dashboards, all phone tabs, stopped phone,
account menus and keyboard focus. Page captures cover 1440 / 1024 / 390px, both themes;
54 page checks returned 200 with no horizontal overflow or browser exceptions. Added
200% text crops and native-size landing sections in preview/redesign/details. Dev logs
contain no unstable Date.now/prerender errors. Used only fake sessions/users/phones in
a disposable design DB; no real GitHub calls. Temporary DB/key/session files were removed
and the port 4321 server stopped. Auth semantics and the historical site stay intact.
