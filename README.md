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

`page/buddy-sprites.png` is the generated sheet used by the shipped page. The normalizer requires a separate source image; it refuses a missing source, a source resolving to the generated destination, or a symlink destination:

```bash
DSH_BUDDY_SPRITES_SOURCE=/path/to/sprite-sheet.png python3 scripts/normalize-sprites.py
```

The repository ships only the generated 8×6 sheet of 192px cells with a transparent background and blue recolor.

## Dev / lab

```bash
pnpm test
pnpm run build
DSH_HOME=~/.dsh-lab dsh plugin --profile web add link:$PWD
# restart the lab web process, then provide its one-time root authentication URL:
DSH_BUDDY_AUTHENTICATE_URL='http://127.0.0.1:3082/?token=...' ./scripts/kiosk.sh
```

Kiosk target: `http://127.0.0.1:3082/buddy`. The launcher uses Chromium's private `--remote-debugging-pipe` transport rather than a TCP DevTools port: it starts at `about:blank`, opens the root authenticateUrl to commit the cookie, and only then navigates to the exact `/buddy` URL in the same private profile with extensions disabled. The token is sent only through DevTools and never appears in Chromium arguments, child environment, or logs. Authentication events are bound to the `Page.navigate` frame. `scripts/kiosk.py` is only a compatibility entrypoint to the same Chromium launcher; it has no WebKit or alternate token-URL path. No user-supplied Chromium arguments are accepted, and the child environment is allowlisted without `LD_LIBRARY_PATH`; the authentication token remains available only through CDP.

`fixtures/alpha1/*.tgz` contains the exact official Host/client closure and registry dependencies used by the offline artifact gate. `fixtures/alpha1/provenance.json` records each archive size, SHA-256, official tag/commit or registry source integrity (including normalized archive integrity where needed), and locked parent-to-child package graph edges with declaration ranges, fields, and reachability. `pnpm run check:artifact` validates that graph and installs a fresh temporary consumer from these archives without the project dependency tree.

## Authentication (alpha.1)

Buddy authenticates every page, asset, SSE stream, navigate request and interaction response through the official Host Connection service. Alpha.1 requires a two-step browser exchange:

- **First login** — open `connection.authenticatedUrl(origin)`, which always targets the root `/` token exchange. The Host sets its HttpOnly `dsh-auth-<base64url(SHA-256(authority))>` cookie there; then open `/buddy` in the same browser.
- **Buddy routes** — `connection.requestRejection` validates the browser cookie and Host/Origin fence before any route data is read. It returns the exact 401/403 status first; methods are `GET` for SSE, `POST` + `application/json` for navigate and interaction responses, and `GET`/`HEAD` for assets. HTML and assets use `Cache-Control: private, no-store`; cross-origin requests are rejected through Connection, not a Buddy-specific token. The interaction response route returns 400 only for invalid JSON/body, 404 for an unknown interaction, and 500 when the broker callback fails. The page drops SSE event data over 512 KiB and any frame that fails its complete snapshot/interaction schema, count consistency, or unique-ID checks. Early route rejections discard the request before sending 400, 401, 403, 404, 405, 413, or 415.

All Buddy routes are registered as one effect-owned bundle (`ctx.effect`). Disposal removes the six named routes, the `BuddyStore` subscription, the archive poll timer and every open server response; it is idempotent and rolls back prior routes if a later registration throws. The client effect owns its EventSource and retries the client SSE stream every 4 seconds, a fixed protocol constant.

### Kiosk launch URL

The kiosk must open an *authenticated* URL for its first login. Derive it safely without hardcoding a workstation or port:

```ts
import { kioskLaunchUrls } from 'dsh-buddy'

declare const connection: Parameters<typeof kioskLaunchUrls>[0]
declare const config: Parameters<typeof kioskLaunchUrls>[1]
declare const webServer: Parameters<typeof kioskLaunchUrls>[2]

const { authenticateUrl, kioskUrl } = kioskLaunchUrls(connection, config, webServer)
// Open authenticateUrl first; alpha.1 mints the cookie only at `/`.
// After the root exchange completes, open kioskUrl (`/buddy`) in that browser.
```

`config.publicBaseUrl` is the canonical browser-reachable `http` or `https` origin (e.g. `http://192.168.1.20:3082`) required for wildcard or non-loopback binds. It has no credentials, path, query, or hash. An empty value is valid only for a `127.0.0.1` bind, where the loopback origin is derived. Configure the same authority in the official Connection service `trustedHosts`; Buddy does not widen that fence.

The kiosk reachability probes use validated seconds-based environment inputs: `DSH_BUDDY_WAIT_TIMEOUT_S` defaults to 30 and is bounded to 300, `DSH_BUDDY_WAIT_REQUEST_TIMEOUT_S` defaults to 2 and is bounded to 30, and `DSH_BUDDY_WAIT_POLL_S` defaults to 0.4 and is bounded to 30. Each value must be positive and no greater than the total timeout.

```bash
# lab: the launcher receives the one-time root URL through its environment
[dsh-buddy] kiosk authentication URL is provided to the launcher through DSH_BUDDY_AUTHENTICATE_URL
[dsh-buddy] kiosk kioskUrl (open after cookie): http://127.0.0.1:3082/buddy

# LAN / 0.0.0.0 deployment: set the origin the kiosk actually reaches
# cordis.patch.yml overlay or --config:
# buddy:
#   publicBaseUrl: "http://192.168.1.20:3082"
# provide the generated one-time root URL through DSH_BUDDY_AUTHENTICATE_URL; do not print or log it
```

The one-time launch token is unpadded base64url for 32 random bytes, exactly 43 characters from `[A-Za-z0-9_-]`; other lengths or characters are rejected. The resulting host-only `dsh-auth-<base64url(SHA-256(authority))>` cookie is bound to the exact origin authority and requires `Path=/`, HttpOnly, and SameSite=Strict. Secure is not required for the shipped loopback HTTP server. Replaying the token after login redirects to `/` if already authenticated, otherwise 401. When set, `DSH_BUDDY_KIOSK_DATA` must already be an absolute path; otherwise the kiosk derives an absolute XDG runtime or `/tmp` path. Chromium stores that cookie only in the owner-only 0700 directory; the profile and every existing parent component are lstat-checked without following links, and symlink parents or non-directories are rejected.

## Configuration (alpha.1)

```yaml
# cordis.patch.yml overlay
- id: buddy
  config:
    archivePollMs: 4000        # 1..2147483647 ms; alpha.1 has no archive-change event
    publicBaseUrl: ""          # explicit browser origin when host is 0.0.0.0
```

- **`archivePollMs` (default `4000`)** — positive safe-integer interval up to `2147483647` ms for `workspaceRegistry.archivedSessionIds`. Alpha.1 exposes only this getter; `WorkspaceRegistry` has no public archive-change event or subscription interface. Buddy therefore reads the getter on each interval, passes the result to `store.setArchived`, and retries on the next interval after a read or update failure while logging at most three failures per 60-second window. This is the durable alpha.1 limitation.
- **`publicBaseUrl`** — see launch URL above.

Buddy exclusively uses official `SessionEvent`/`SessionHeader`/`Agent`/`WorkspaceRegistry` types. Its `BuddySnapshot`/`BuddySessionView` and mood projection are stable; the fold handles the published `session/title`, `user/message`, `assistant/message`, `tool/call` and turn events, while merge-extensible ignorable events only update activity time. Approval state comes from the approval service rather than synthetic durable session events.

## Artifact gate

```bash
pnpm run build
pnpm run pack:check   # Python regressions, real tarball, exports/assets, offline consumer, Host + ModuleLoader smoke, closure
```

The gate fails hard on any missing export/asset, forbidden packed path or special tar entry, dependency alias, fixture integrity mismatch, static-closure error, or isolated consumer failure. It uses the real tarball, a temporary empty pnpm store, an invalid registry, offline installation, scrubbed subprocess environments, audited lstat/realpath cleanup roots, and actual client ModuleLoader execution.


## Release installation (Latest)

USB sub-screen mood dashboard and touch remote for approvals, questions, and session navigation. The release artifact targets DeepSeek Harness 0.1.2-alpha.1 and contains built Host/Client files only; it has no sibling-repository source, workstation path, link:, or workspace: dependency.

Latest installation (the URL never contains a version):

~~~sh
dsh plugin --profile web add --force \
  https://github.com/NOirBRight/dsh-buddy/releases/latest/download/dsh-buddy.tgz
~~~

Fixed-version installation:

~~~sh
dsh plugin --profile web add --force \
  https://github.com/NOirBRight/dsh-buddy/releases/download/v0.1.0/dsh-buddy.tgz
~~~

Update, uninstall, and verify:

~~~sh
# Update to the latest Release
dsh plugin --profile web add --force \
  https://github.com/NOirBRight/dsh-buddy/releases/latest/download/dsh-buddy.tgz
# Verify the loaded version
dsh plugin --profile web list
dsh plugin --profile web doctor
# Uninstall only this plugin
dsh plugin --profile web remove dsh-buddy
~~~

Configuration: use the plugin section in Settings for Web UI plugins, or the profile dsh.profile.bundles entry for Host-only plugins. Start with this README's minimal YAML/JSON example and provide credentials/backend addresses explicitly.

Rollback: rerun the fixed v0.1.0 command, verify the profile list, then restart the Web service once. Inspect journalctl --user -u dsh-web.service and dsh plugin --profile web doctor; never put a source checkout in the production profile.

Release and integrity: [v0.1.0](https://github.com/NOirBRight/dsh-buddy/releases/tag/v0.1.0) · [SHA256SUMS](https://github.com/NOirBRight/dsh-buddy/releases/download/v0.1.0/SHA256SUMS).
