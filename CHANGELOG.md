# Changelog

## 0.1.0 — 2026-09-12

The first supported local release of NTS to Spotify.

### Added

- Import one NTS episode or progressively scan a complete show catalogue.
- Persist catalogue scanning, review choices, cooldowns, and resumable progress in the browser.
- Use bounded Spotify retries, explicit rate-limit handling, and a persistent cache of public
  Spotify match results.
- Remove exact duplicate Spotify track URIs while preserving the configured episode and track
  ordering.
- Preview linked-playlist changes before Spotify is modified.
- Update the same linked Spotify playlist as new NTS episodes are reviewed.
- Resume ordered playlist synchronization with settlement checks and safeguards for ambiguous
  writes.
- Run a standalone adapter-node production server with Windows setup and startup launchers.
- Distribute the project under the MIT License with Pedro Brandão's original attribution.

### Known limitations

- Every local user must create and supply their own Spotify application credentials.
- Node 24 LTS is recommended.
- Windows has received real manual acceptance testing. The documented Linux and macOS commands
  have not received equivalent manual platform testing.
- The installation must remain in a directory writable by the user running the application.
- Local mode listens on IPv4 loopback (`127.0.0.1`) only.
- Public hosting is outside the scope of this release.
