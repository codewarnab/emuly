# Final redesign screenshots

Blue porcelain and cobalt in light; layered night blue and cornflower in dark.
Public Sans body with Sora headings. The cobalt phone with overlapping porcelain discs is
the shared visual motif.

62 final PNGs, individually inspected after the Round 4 lead review, including 200% small-text crops.
All signed-in pages use fake users/sessions and two fake phones in a disposable design
DB inside an isolated Bubblewrap workspace. The running-phone view is illustrative;
Phase 2 has no connected lifecycle or streaming controls. No real GitHub requests.

Enlarged text crops and native-size landing sections: [details](details/).
Round 4 diagnosis and removals: [DESIGN.md](../../docs/DESIGN.md#round-4--lead-review-type-availability-and-composition).

## Verification

- `pnpm lint`: pass (TypeScript check).
- `pnpm test`: pass, 3 tests. Existing Node module-type warnings only.
- `pnpm build`: pass, all 10 pages generated; Cache Components enabled.
- Browser interactions: theme default, persistence and live system changes; protected
  route redirect; account menu/logout; typed deletion confirmation; tabs; keyboard focus.
- 54 layout measurements: no horizontal overflow, no browser exceptions.
- Dev overlay: no Date.now / unstable-value prerender insight on authenticated dashboard.
- Contrast: see `contrast-checks.json` for text, semantic controls and focus token pairs.
- No dependencies or commits. Production data and `.env.local` untouched.

## Screenshot paths

Every link below is a final file in `/home/ubuntu/code/phonelink/preview/redesign/`.

- [account-menu-dark-1440.png](account-menu-dark-1440.png)
- [account-menu-dark-390.png](account-menu-dark-390.png)
- [account-menu-light-1440.png](account-menu-light-1440.png)
- [account-menu-light-390.png](account-menu-light-390.png)
- [dashboard-dark-1024.png](dashboard-dark-1024.png)
- [dashboard-dark-1440.png](dashboard-dark-1440.png)
- [dashboard-dark-390.png](dashboard-dark-390.png)
- [dashboard-light-1024.png](dashboard-light-1024.png)
- [dashboard-light-1440.png](dashboard-light-1440.png)
- [dashboard-light-390.png](dashboard-light-390.png)
- [empty-dark-1024.png](empty-dark-1024.png)
- [empty-dark-1440.png](empty-dark-1440.png)
- [empty-dark-390.png](empty-dark-390.png)
- [empty-light-1024.png](empty-light-1024.png)
- [empty-light-1440.png](empty-light-1440.png)
- [empty-light-390.png](empty-light-390.png)
- [keyboard-focus-dark-1440.png](keyboard-focus-dark-1440.png)
- [keyboard-focus-dark-390.png](keyboard-focus-dark-390.png)
- [keyboard-focus-light-1440.png](keyboard-focus-light-1440.png)
- [keyboard-focus-light-390.png](keyboard-focus-light-390.png)
- [landing-dark-1024.png](landing-dark-1024.png)
- [landing-dark-1440.png](landing-dark-1440.png)
- [landing-dark-390.png](landing-dark-390.png)
- [landing-light-1024.png](landing-light-1024.png)
- [landing-light-1440.png](landing-light-1440.png)
- [landing-light-390.png](landing-light-390.png)
- [login-dark-1024.png](login-dark-1024.png)
- [login-dark-1440.png](login-dark-1440.png)
- [login-dark-390.png](login-dark-390.png)
- [login-light-1024.png](login-light-1024.png)
- [login-light-1440.png](login-light-1440.png)
- [login-light-390.png](login-light-390.png)
- [phone-apps-dark-1024.png](phone-apps-dark-1024.png)
- [phone-apps-dark-1440.png](phone-apps-dark-1440.png)
- [phone-apps-dark-390.png](phone-apps-dark-390.png)
- [phone-apps-light-1024.png](phone-apps-light-1024.png)
- [phone-apps-light-1440.png](phone-apps-light-1440.png)
- [phone-apps-light-390.png](phone-apps-light-390.png)
- [phone-backups-dark-1024.png](phone-backups-dark-1024.png)
- [phone-backups-dark-1440.png](phone-backups-dark-1440.png)
- [phone-backups-dark-390.png](phone-backups-dark-390.png)
- [phone-backups-light-1024.png](phone-backups-light-1024.png)
- [phone-backups-light-1440.png](phone-backups-light-1440.png)
- [phone-backups-light-390.png](phone-backups-light-390.png)
- [phone-danger-dark-1024.png](phone-danger-dark-1024.png)
- [phone-danger-dark-1440.png](phone-danger-dark-1440.png)
- [phone-danger-dark-390.png](phone-danger-dark-390.png)
- [phone-danger-light-1024.png](phone-danger-light-1024.png)
- [phone-danger-light-1440.png](phone-danger-light-1440.png)
- [phone-danger-light-390.png](phone-danger-light-390.png)
- [phone-log-dark-1024.png](phone-log-dark-1024.png)
- [phone-log-dark-1440.png](phone-log-dark-1440.png)
- [phone-log-dark-390.png](phone-log-dark-390.png)
- [phone-log-light-1024.png](phone-log-light-1024.png)
- [phone-log-light-1440.png](phone-log-light-1440.png)
- [phone-log-light-390.png](phone-log-light-390.png)
- [phone-stopped-dark-1024.png](phone-stopped-dark-1024.png)
- [phone-stopped-dark-1440.png](phone-stopped-dark-1440.png)
- [phone-stopped-dark-390.png](phone-stopped-dark-390.png)
- [phone-stopped-light-1024.png](phone-stopped-light-1024.png)
- [phone-stopped-light-1440.png](phone-stopped-light-1440.png)
- [phone-stopped-light-390.png](phone-stopped-light-390.png)

Temporary design DB, dummy credentials, browser harness and sandbox removed after verification.
Port 4321 has no listener; all preview servers stopped.
