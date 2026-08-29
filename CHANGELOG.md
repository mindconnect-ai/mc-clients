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
