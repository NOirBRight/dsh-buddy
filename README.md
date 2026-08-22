# dsh-buddy

Pixel whale on the AM01S `960×400` USB sub-screen. It is a mood dashboard for every live DSH session, and a touch remote for simple approvals, multiple-choice questions, and jumping the main GUI to a session.

## Moods (highest urgency wins)

1. **needs-you** — any session waiting on approval / question / plan-review
2. **error** — a turn ended with `error`
3. **working** — any session running
4. **done-unseen** — a turn completed and nobody has opened it yet
5. **idle** — otherwise; tap the whale to pet it

## Layout

Theater: whale centered with a large mood word, sessions as a ticker along the bottom. Tap a chip, or a confirmation arriving, slides the whale left and opens a speech bubble on the right (session detail, or approve / pick buttons). Designed for the native `960×400` panel.

UI variants from the prototype live on branch `prototype/ui-variants`. The shipped page is variant B (theater + bubble). The whale is a soft cornflower blue (hue +50°, saturation ×0.70, value ×1.30 from the teal original).

## Sprites

`page/buddy-sprites.orig.png` is the generated sheet. Recolor / recut / swap the original, then regenerate:

```bash
python3 scripts/normalize-sprites.py
```

That writes `page/buddy-sprites.png` (8×6 cells of 192px, transparent background, blue recolor).

## Dev / lab

This is a host + client DSH plugin. Verify on **3082 / `~/.dsh-lab`**, never on 3080.

```bash
pnpm test
pnpm run build
DSH_HOME=~/.dsh-lab dsh plugin --profile web add link:$PWD
# restart the lab web process, then:
./scripts/kiosk.sh
```

Kiosk target: `http://127.0.0.1:3082/buddy`. The GTK4 + WebKit shell fullscreen's onto the 960×400 monitor when present; Chromium `--app` is the fallback.

Debug query params (kiosk-safe, no host mutations): `?mock=1` injects fake sessions; `?open=<id>` pre-opens a bubble.
