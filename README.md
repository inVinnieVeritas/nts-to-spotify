# NTS to Spotify

Create a Spotify playlist from one NTS episode or an entire NTS show catalogue.

The full-show importer reads the official paginated NTS catalogue and tracklist APIs, scans
episodes progressively, and keeps uncertain Spotify matches unchecked for manual review. Before
creating the playlist it removes exact duplicate Spotify track URIs while preserving alternate
versions and remixes.

## Local setup

1. Create a Spotify app in the Spotify developer dashboard.
2. Add `http://localhost:5173/login` as a redirect URI.
3. Copy `.env.example` to `.env` and provide `SPOTIFY_CLIENT_ID` and
   `SPOTIFY_CLIENT_SECRET`.
4. Install dependencies and run the app:

```bash
npm ci
npm run dev
```

Paste either a show URL such as `https://www.nts.live/shows/jim-o-rourke` or an individual
episode URL into the search bar. A full catalogue scan can take several minutes because Spotify
requests are deliberately rate-limited and uncertain matches require review.

## Checks

```bash
npm run check
npm run build
```

Spotify OAuth requests public and private playlist modification scopes. Users who authenticated
before those scopes were added need to log out and reconnect Spotify.
