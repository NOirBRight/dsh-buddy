# dsh-buddy

Pixel whale on the AM01S `960×400` USB sub-screen. It is a mood dashboard for every live DSH session, and a touch remote for simple approvals, multiple-choice questions, and jumping the main GUI to a session.

## Moods (highest urgency wins)

1. **needs-you** — any session waiting on approval / question / plan-review
2. **error** — a turn ended with `error`
3. **working** — any session running
4. **done-unseen** — a turn completed and nobody has opened it yet
5. **idle** — otherwise; tap the whale to pet it

## Layout

Left ~340px: sprite stage. Right ~620px: pending answer card + session list. Designed for the native `960×400` panel, dark, local animation only.

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
