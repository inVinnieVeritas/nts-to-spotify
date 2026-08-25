# NTS to Spotify

Create a Spotify playlist from one NTS episode or an entire NTS show catalogue.

The full-show importer reads the official paginated NTS catalogue and tracklist APIs, scans
episodes progressively, and keeps uncertain Spotify matches unchecked for manual review. Before
creating the playlist it removes exact duplicate Spotify track URIs while preserving alternate
versions and remixes.

## Local setup

1. Create a Spotify app in the Spotify developer dashboard.
2. Add exactly `http://127.0.0.1:5173/login` as a redirect URI.
3. Copy `.env.example` to `.env` and provide `SPOTIFY_CLIENT_ID` and
   `SPOTIFY_CLIENT_SECRET`. Use credentials from your own Spotify app. Never share or reuse the
   maintainer's credentials.
4. Install dependencies and run the app:

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173` in your browser.

Paste either a show URL such as `https://www.nts.live/shows/jim-o-rourke` or an individual
episode URL into the search bar. A full catalogue scan can take several minutes because Spotify
requests are deliberately rate-limited and uncertain matches require review.

## Local Spotify match cache

Successful Spotify matches are cached in `.data/spotify-match-cache` on the local Node
installation. This reduces repeated searches across scans and restarts, but it neither increases
nor reveals Spotify quota. The cache contains public match metadata, not credentials. Deleting
that directory clears only the match cache and does not delete catalogue progress. Serverless
hosts may not preserve local files; a durable hosted adapter remains future deployment work.

The cache directory must be owned and writable only by the operating-system account running the
application. Shared or adversarially writable project directories are unsupported; public hosting
must keep both application and cache directories inaccessible to untrusted writers. The cache
contains no credentials or private Spotify account data. Node cannot provide fully handle-relative
filesystem operations on every supported platform, so the cache fails closed on detected links or
path replacement but does not claim protection against continuous same-user path replacement.

## Checks

```bash
npm run check
npm run build
```

Spotify OAuth requests public and private playlist modification scopes. Users who authenticated
before those scopes were added need to log out and reconnect Spotify.

## Development toolchain notes

- The newest stable SvelteKit currently brings `@polka/url@1.0.0-next.29` through Sirv. This
  unavoidable transitive dependency must not be overridden to the incompatible stable 0.5.0
  release.
- The full npm audit reports three Low nodes for one `cookie@0.6.0` advisory through SvelteKit and
  adapter-auto. The application uses fixed cookie names and paths, `npm audit --omit=dev` reports
  zero vulnerabilities, and no compatible upstream correction is currently available.
