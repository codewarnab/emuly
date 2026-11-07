# Problem statement: keeping a phone between visits

Status: design input, 2026-11-05.

## 1. What the product promises

phonelink gives an agent a real Android phone inside the user's own GitHub
Codespace. Today the phone is disposable. The container disk survives a
codespace stop, but the Android image itself starts from a clean AVD, and the
agent has to boot it, configure it, and install the app again on every visit.

The new promise is small and exact:

> "Keep this phone" means the next visit returns the same Android state:
> installed apps, signed-in accounts, saved files, and app data. Resume should
> take seconds, not a cold boot.

Wipe stays the default. Keeping is opt-in per phone and can be turned off.

## 2. What breaks today

1. The AVD is created with `-read-only`. A writable AVD costs disk and can be
   corrupted, so the rig avoids it. Read-only means no state is written to the
   image at all.
2. The rig kills qemu on exit. A hard kill during a disk write can leave
   `userdata-qemu.img` inconsistent, so the saved phone may not boot next time.
3. There is no snapshot step. Nothing saves the running state before the
   codespace stops.
4. The codespace disk holds everything else too: Android SDK, the AVD system
   image, the app source, and the Gradle cache. A writable AVD adds roughly
   1 to 2 GB per phone on top of that.
5. Nothing enforces the user's storage budget. The free plan allows 20 GB-month.
   A silently full disk breaks saves with no warning.

## 3. Hard constraints

| Constraint | Value | Where it comes from |
|---|---|---|
| Slot size | 4 vCPU, 16 GB RAM, 32 GB disk | measured on `damp-cape-wr7pp95x7qqpcqrv` |
| Phones per slot | 1 default, 2 max solid, 3 only light | stress test: CPU 394% of 400% at 3 phones |
| Free storage | 20 GB-month per account | GitHub Pro plan |
| Idle lifetime | stopped codespaces deleted after 30 idle days | GitHub policy |
| Token scope | `codespace` only | our OAuth app; no repo scope |
| Boot time | 40 s cold for 1, 56 s at 2, 64 s at 3 | measured |
| Resume target | under 20 s | new goal |

## 4. Failure modes the design must answer

1. Codespace stops while the agent is still writing to the phone.
2. Two phones are saved in one slot and the disk fills halfway through the
   second save.
3. The codespace is recreated on a machine with a different disk size.
4. A saved image is corrupt. The rig must detect this before promising resume.
5. The user's 30 idle days expire and GitHub deletes the codespace. The phone
   must fail with a clear message, not a broken boot.
6. A resumed codespace ships a newer system image than the one that was saved.
7. The user has two phones and only wants to keep one.

## 5. Non-goals

- Moving a phone between accounts or devices.
- Backing up to storage outside GitHub.
- Keeping the emulator running while the user is away. That burns core-hours
  and would break the free model.

## 6. What the plan must contain

1. A lifecycle state machine for a phone: created, running, saved, resumed,
   expired.
2. A component diagram: agent, rig CLI, AVD layer, relay, GitHub API.
3. A sequence diagram for the save path and one for the resume path.
4. A storage layout with real byte budgets that fit in a 32 GB disk.
5. A rule for what counts as a save, and what happens to unsaved writes.
6. Corruption detection and a safe fallback path.
7. Quota accounting and the warning threshold.
8. The API surface: which commands the agent calls, and what the relay exposes.
9. A phased implementation plan with a test strategy for each phase.
