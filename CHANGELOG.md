# Changelog

What changed, in the words of someone who has to decide whether to download the
new version.

This is not the commit log — [the releases page][releases] has that, generated.
An entry here earns its place by telling a *user of the apps* what is different
for them: something the launcher can now do, a behaviour that changed, a bug
whose symptom they may have been living with.

The format is [Keep a Changelog][keepachangelog]; this project follows
[semantic versioning][semver].

**Adding an entry:** put it under `## [Unreleased]`, in the section that fits.
The release workflow renames that heading to the version being tagged and opens
a fresh empty one, so nothing has to be moved by hand at release time. The
entry also becomes the "what is new" half of the release note, above the
evergreen download and installation instructions in
[RELEASE_NOTES.md](RELEASE_NOTES.md).

[releases]: https://github.com/mindconnect-ai/mc-clients/releases
[keepachangelog]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

### Added

- **The launcher lists every branch's snapshot channel.** The server now
  publishes one pre-release per branch — `snapshot` for main, `snapshot-<branch>`
  for the rest — and the version list shows them all: main's first, then the
  branches newest build first, each with its branch, commit and build time.
  A branch build is for trying a fix before it is merged; it never becomes the
  version Start picks on its own. When GitHub's API cannot be asked, the list
  falls back to main's channel, as before.
- **Kill next to Stop.** Stop still asks the server to shut down cleanly and
  waits up to 15 seconds before forcing it. Kill sits beside it, armed once
  Stop is under way, and ends the server right away.
- **A Remote tab, switched off by default.** The home end of the mobile relay:
  configure the Firebase connector, start and stop it, watch its log — it runs
  inside the launcher for as long as the window is open. It needs a Firebase
  project of your own, so it only appears when asked for: start the launcher
  with `--remote`, `-Dlauncher.remote=true` or `MC_LAUNCHER_REMOTE=true`.
- **Persistence settings in the Environment tab.** `MC_PERSISTENCE` as a choice
  between `file` and `postgres`, plus the postgres connection — URL, user,
  password — as named fields instead of lines in "Additional variables".

### Changed

- Start and Stop no longer hold the window behind a spinner. A first Start
  downloads the build in the background while the status line and the log
  show what is happening; Stop waits in the background too, which is what
  makes room for Kill.

## [1.1.0] - 2026-08-30

### Changed

- **The clients render on semantic-ui 0.2.0.** The released sheet with the
  spacing/type scale and row alignment work — ahead of the released parent's
  0.1.3 pin, via an override that goes away when the next parent release
  catches up.

### Added

- **Clody, a warm look for the launcher.** Start it with
  `-Dlauncher.theme=clody` (or `MC_LAUNCHER_THEME=clody`) for bone-and-clay
  neutrals instead of the default cool-slate scale, at one type size up. It is
  the desktop half of the theme the admin web UI ships, so the two read as the
  same product. Without the flag nothing changes.

- **The launcher can install development builds.** Next to the releases from
  Maven Central, the version list now offers the current snapshot from the
  server's rolling `snapshot` pre-release, with the commit and build time it
  came from. Because a snapshot keeps its version while the build behind it
  moves on, *Download* fetches it again even when that version is already
  installed.
- Snapshots arrive as a single executable jar, so installing one no longer
  needs a local Maven to resolve a few hundred dependency files.
- **The chat answers approval requests.** When a tool needs a human, the
  transcript shows a card with the call and its arguments and three ways out:
  deny, allow once, allow for the rest of the conversation. Questions raised
  while no window was open are loaded when the conversation is opened, so a
  restart no longer strands a waiting agent.
- **The chat reattaches to a running answer.** Opening a conversation that is
  being answered right now — by a window that was closed, or a second client —
  follows that turn to its end instead of showing a transcript that stops
  mid-thought.

  Both need a server that has the endpoints, which means a snapshot build or
  anything after 0.0.2. Against an older server the chat notices they are
  missing and carries on without them.

### Changed

- Starting without an explicitly chosen version still launches the newest
  *release* — the snapshot heads the list but is never what you land on by
  accident.

## [1.0.0] - 2026-08-28

### Added

- **MindConnect Admin Launcher**, a desktop app that runs the agent server for
  you: pick and download a version from Maven Central, edit the environment
  (encryption key generation included), start and stop the server, and open the
  Admin UI in your browser. A server left running by an earlier session is
  adopted through its pid file and can be stopped from a fresh launcher.
- Installers for macOS (Apple silicon and Intel), Windows and Debian/Ubuntu,
  each with its own bundled Java runtime — nothing to install first. Plus a
  per-platform `-all.jar` for anyone who already has a Java 21 runtime and
  would rather skip the installer (on macOS also the way around Gatekeeper
  while the app is not yet notarized).
