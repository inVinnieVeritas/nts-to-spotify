# NTS to Spotify

Create a Spotify playlist from one NTS episode or an entire NTS show catalogue.

The full-show importer reads the official paginated NTS catalogue and tracklist APIs, scans
episodes progressively, and keeps uncertain Spotify matches unchecked for manual review. Before
creating the playlist it removes exact duplicate Spotify track URIs while preserving alternate
versions and remixes.

## Supported local edition

The supported local edition runs as a production Node server for the person using the computer.
It binds only to `127.0.0.1:5173` by default, is not exposed to the local network, and does not
open a browser automatically.

Use Node 24 LTS when possible. Node 20.19+ and 22.13+ remain compatible fallbacks, although older
compatible Node releases may not be able to use the operating system certificate store.

The local URL is `http://127.0.0.1:5173/`.

Keep that host and port stable. Browser IndexedDB and localStorage are isolated by origin, so
using `localhost`, another address, or another port will show a different set of browser data.

## Download the Windows release

Open the GitHub Releases page, download the `v0.1.0` source ZIP, and extract it into a folder
writable by your Windows account. Run `setup-local.cmd`, add your personal Spotify credentials to
the new `.env`, and then run `start-local.cmd`. In your Spotify application settings, register
exactly `http://127.0.0.1:5173/login` as the redirect URI. The sections below explain each step and
the available troubleshooting options in more detail.

## Create a personal Spotify application

1. Sign in to the Spotify developer dashboard and create an application for your own use.
2. Add this exact redirect URI: `http://127.0.0.1:5173/login`.
3. Copy the application's client ID and client secret into your local `.env` file.

Spotify does not treat `localhost` as interchangeable with `127.0.0.1`. Never share your
client secret, completed `.env`, browser cookies, or downloaded progress backups.

## Windows one-time setup

Clone or unpack the project into a directory owned by your Windows account. Do not install it in
a shared or administrator-only directory. Run:

```bat
setup-local.cmd
```

The setup checks Node and npm, uses the operating system certificate store when Node supports it,
creates `.env` from `.env.example` only when it is absent, runs `npm ci`, and creates the
production build. It never overwrites an existing `.env` or changes environment settings outside
that setup process.

Open `.env` in a text editor and provide both entries:

```dotenv
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

## Windows normal startup

After setup, run:

```bat
start-local.cmd
```

Then open `http://127.0.0.1:5173/`. Press `Ctrl+C` in the server window to request shutdown.
Starting the app never installs dependencies, rebuilds it, or opens a browser.

The launcher runs adapter-node in the same foreground Node process. Native Windows console
interrupts and POSIX SIGINT/SIGTERM request the adapter's bounded 30-second connection drain;
there is no child-process signal forwarding. A 35-second final deadline ends a process that
has not exited. Forced termination, closing the terminal, or a deadline expiry can leave a
Spotify operation uncertain: use the existing reconciliation flow, not an assumption that
Spotify cancelled it. Do not stop the server while an import is active if avoidable.

Windows wrappers support local paths containing spaces and `!`, including callers using delayed
expansion. UNC installation paths are rejected. They stop if their directory cannot be selected.
Remove inherited `NODE_OPTIONS` and `NODE_TLS_REJECT_UNAUTHORIZED` before using the wrappers;
they configure supported system-CA behavior themselves. Do not start Node with untrusted runtime
options: Node processes those before any JavaScript launcher can validate them.

## Linux and macOS

Use the same production launcher:

```bash
cp .env.example .env
# Edit .env and add your personal Spotify credentials.
npm ci
npm run build
npm run start:local
```

Press `Ctrl+C` to request shutdown. The launcher augments Node's default TLS roots with system
roots using the runtime certificate APIs (Node 22.19+ or 24.5+). On older compatible versions,
it warns and retains default TLS verification. Current Node 24 LTS is recommended.

## Development workflow

The Vite development workflow remains available:

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

Development mode is not the supported production experience. To exercise the production build,
use `npm run build` followed by `npm run start:local`.

For a generic hosted Node environment, `npm start` starts the adapter-node output and expects
the host to inject runtime environment variables. It does not load the local `.env` file.

## Safe local overrides

The launcher accepts a different loopback port for controlled testing:

```bash
npm run start:local -- --port 5174
```

Configuration is parsed as data with Node's built-in parser. Only the two Spotify credential
fields are imported; runtime and alternate-listener controls are rejected. Host, port and origin
come only from the validated launcher options, not from `.env` or inherited server settings.

It will still bind only to `127.0.0.1` and derives the origin from the selected port. If the
port changes, register the matching Spotify callback and remember that the browser will use a
different storage origin. An explicit `--origin` is accepted only when it exactly matches the
loopback host and selected port. LAN addresses and `localhost` are rejected.

## Using the importer

Paste either a show URL such as `https://www.nts.live/shows/jim-o-rourke` or an individual
episode URL into the search bar. A full catalogue scan can take several minutes because Spotify
requests are deliberately paced and uncertain matches require review.

## Catalogue backup and restore

Catalogue progress is stored in this browser. On the private Cloud Run staging installation, you
can also choose **Save this browser’s progress to cloud** on the show page. A new browser lists
cloud catalogues on the home page and restores a cloud copy when you open one. If two browsers
have different progress, automatic sync pauses and asks which copy to keep. Download a backup
before replacing either copy. The local Vite edition continues to use browser storage; transfer
its progress with a JSON backup.

Use **Download backup** on a catalogue page or the Saved Catalogues dashboard after important
reviews and playlist updates. Use **Restore progress** on the matching show page to import the
JSON backup. Restoring or resetting local progress pauses cloud sync until you choose a copy.

A backup contains catalogue results, review choices, playlist settings, and compatible linked
playlist state. It deliberately excludes Spotify credentials, tokens, cookies, server cache data,
and local synchronization diagnostics. Treat backups as personal data because they describe your
catalogue and review choices.

## What persists locally

- **IndexedDB:** catalogue progress, completed matches, review decisions, playlist settings, and
  resumable playlist synchronization state for this browser origin.
- **localStorage:** the browser-origin-wide Spotify Search cooldown.
- **Private Cloud Run staging only:** optional Firestore copy of catalogue progress, split by
  episode under the configured Spotify owner's account. Browser progress stays available when
  cloud sync is unavailable. Scan timers remain local to each browser.
- **HTTP-only cookies:** Spotify access and refresh tokens. Logging out clears authentication but
  does not delete catalogue progress.
- **`.data/spotify-match-cache`:** public Spotify match metadata used to avoid repeated searches
  across local server restarts.
- **Server memory:** short-lived queues, coalesced searches, and server-session metrics, which
  reset when Node stops.

Cache usage reduces repeated searches; it does not increase or reveal Spotify quota.

## Private staging cloud progress setup

The cloud progress API is available only on the private staging domain. It requires the existing
IAP protection and signed Spotify owner session. The server uses its Cloud Run service account to
access Firestore; no Firestore credential or database access is sent to the browser. It does not
make additional Spotify searches.

In project `gen-lang-client-0941278185`, enable `firestore.googleapis.com` and create a Standard
edition Firestore Native `(default)` database in `europe-west1` if one does not already exist.
Check the existing database and its free-tier eligibility before creating one: the first eligible
database in the project receives the Firestore free tier. Choose restrictive Firestore rules because
the browser never needs direct database access. Grant
`roles/datastore.user` to the `nts-staging-runtime` service account, then deploy the built revision
with `NTS_FIRESTORE_PROJECT=gen-lang-client-0941278185`. Do not expose the Cloud Run service
without IAP. Keep the current revision available for rollback until the import and second-browser
checks pass.

Cloud writes use a Firestore document update-time precondition. An unexpected change from another
browser stops automatic upload instead of overwriting the newer copy. The first upload is manual.
Cloud saving is not enabled for local Vite yet.

The cache directory must be owned and writable only by the operating-system account running the
application. Shared or adversarially writable project directories are unsupported. Deleting
`.data/spotify-match-cache` clears only the public match cache; it does not remove browser
catalogue progress or Spotify playlists. Node cannot provide fully handle-relative filesystem
operations on every supported platform, so the cache fails closed on detected links or path
replacement but does not claim protection against continuous same-user path replacement.

## Troubleshooting

### Port 5173 is already in use

The launcher stops instead of silently selecting another port. Stop the application that owns
the port, or deliberately use `--port` and register the corresponding Spotify redirect URI.
Do not stop unrelated Node processes.

### Spotify reports a redirect mismatch

Confirm that the dashboard registration and browser address both use
`http://127.0.0.1:5173/login`. Do not substitute `localhost`, omit the port, or add a trailing
slash.

### Windows certificate errors

Install a current Node 24 LTS release. The launcher enables Node's Windows system certificate
store in the server process when supported. Never work around certificate errors with
`NODE_TLS_REJECT_UNAUTHORIZED=0` or another TLS-verification bypass. If a managed network still
fails, ask its administrator to install the required CA correctly.

### A native dependency is locked

Stop only development or production servers using this installation, close terminals that are
running project tools, and retry the explicit `npm ci`. Do not run dependency installation on
every startup and do not delete unrelated Node processes.

### Configuration or build is missing

Run `setup-local.cmd` on Windows or the documented `npm ci` and `npm run build` commands on
Linux/macOS. The launcher reports missing or empty configuration without printing credential
values.

### The cache directory is not writable

Move the whole installation to a directory owned by your user account. The local edition is not
designed to write under administrator-only application directories.

## Updating an existing installation

For a safe Windows upgrade to a packaged release:

1. Download and extract the new release into a new folder.
2. Stop the old server with `Ctrl+C` after active operations finish.
3. Copy the existing `.env` file into the new folder.
4. Copy the existing `.data` directory into the new folder if it exists.
5. Run `setup-local.cmd` in the new folder.
6. Start the application with `start-local.cmd`.
7. Open the same `http://127.0.0.1:5173/` address.
8. Confirm that saved catalogues and linked playlists remain available.
9. Keep the old installation until the new version is verified.

Downloaded catalogue backups are recommended before updating. Browser catalogue data is tied to
the browser origin (scheme, host, and port), so using the same address preserves access to it.
The `.data` directory is installation-local and contains server-side public match-cache and
cooldown information. Do not commit or share `.env` or `.data/`.

## Security and privacy

The local edition is intended for one person on one computer. Loopback binding prevents direct
LAN access, but it does not protect against malicious software running under the same operating
system account. The local `.env`, browser profile, backups, and cache directory are not encrypted
by this application; rely on operating-system account and disk protection.

Spotify OAuth requests public and private playlist modification scopes. Users who authenticated
before those scopes were added need to log out and reconnect Spotify.

This project is not affiliated with NTS.

## Future public hosting

Public hosting is a separate deployment step, not a different application fork. The adapter-node
build can run on a conventional Node host when it is supplied a fixed HTTPS `ORIGIN`, injected
Spotify credentials, trusted reverse-proxy configuration, and durable cache storage. A public,
multi-instance or serverless deployment also needs a dedicated security review and coordinated
storage. Never expose the local launcher directly to the internet.

## Checks

```bash
npm test
npm run check
npm run lint
npm run build
npm audit --omit=dev
```

## Development toolchain notes

- The newest stable SvelteKit currently brings `@polka/url@1.0.0-next.29` through Sirv. This
  unavoidable transitive dependency must not be overridden to the incompatible stable 0.5.0
  release.
- The full npm audit may report a Low development-only cookie advisory through SvelteKit. The
  application uses fixed cookie names and paths; `npm audit --omit=dev` is the production
  dependency check.

## License

MIT. See [LICENSE](LICENSE). This fork remains based on the original NTS to Spotify project by
[pdrbrnd](https://github.com/pdrbrnd/nts-to-spotify).
