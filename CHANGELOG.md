# Changelog

## 0.1.1 — 2026-09-13

A focused patch release for track review accuracy and Windows launcher usability.

### Fixed

- Treat supported trailing `Remaster` and `Remastered` qualifiers as title-equivalent when the
  artist and base title match, without conflating meaningful versions such as live recordings,
  remixes, edits, mono or stereo versions, and re-recordings.
- Reclassify compatible unresolved saved matches when they are displayed, without rescanning or
  rewriting explicit inclusion, exclusion, or alternative-candidate choices.
- Keep Windows setup and startup errors visible when the command files are opened from Explorer,
  while preserving the original exit code after the user dismisses the prompt.
- Avoid pausing existing Command Prompt and PowerShell sessions, CI, redirected input, and
  successful startup.

### Compatibility

- No catalogue rescan is required for the remaster-title correction.
- No playlist synchronization protocol, persistence schema, backup format, or matcher version
  changed in this release.

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
