# mc-clients

Desktop and mobile clients for the MindConnect platform, grouped by
technology. Every client paints its UI from the same `UiNode` vocabulary the
server-side admin pages use — the [Semantic UI](https://github.com/mindconnect-ai/mc-semantic-ui)
renderers do the drawing, the client supplies local handlers.

| Folder | Technology | Status |
|--------|------------|--------|
| [`javafx/`](javafx/) | JavaFX desktop clients | active |
| `ios/` | Swift / iOS clients | idea — depends on a Semantic UI Swift renderer |

## JavaFX clients

The `javafx/` folder is a standalone Maven build — parent POM and platform
artifacts come released from Maven Central:

```bash
mvn -f javafx/pom.xml clean package
```

| Module | Purpose |
|--------|---------|
| [`mc-server-control`](javafx/mc-server-control/) | Manage the locally installed server (download, environment, start/stop, pid-file adoption) — no UI |
| [`mc-server-control-fx`](javafx/mc-server-control-fx/) | The server-control panels as embeddable Semantic UI JavaFX components |
| [`mc-agent-admin-launcher`](javafx/mc-agent-admin-launcher/) | Run the agent server: download a release, pick a version, configure the environment, start / stop, open the Admin UI |
| [`mc-agent-chat`](javafx/mc-agent-chat/) | End-user chat client — work in progress, not part of the release yet |

Planned: a workflow client.

## Download

End-user builds are native installers with a bundled Java runtime — no local
Java needed. They are built by [`release.yml`](.github/workflows/release.yml)
whenever a `v*` tag is pushed, one per platform, and attached to the GitHub
release: `.dmg` (macOS arm64 + x64), `.msi` (Windows), `.deb` (Linux).

Local build of the installer for the current platform:

```bash
mvn -f javafx/pom.xml -pl mc-agent-admin-launcher -Pinstaller package jpackage:jpackage -Djpackage.type=DMG
```

(`DMG` on macOS; `MSI` on Windows, `DEB`/`RPM` on Linux.)

## Releasing

A release is a `v*` tag on `main`. Pushing it is the only manual step —
[`release.yml`](.github/workflows/release.yml) does the rest in GitHub Actions:
it builds the four installers, turns the `## [Unreleased]` section of
[`CHANGELOG.md`](CHANGELOG.md) into the `## [<version>]` section and pushes
that back to `main`, and creates the GitHub release with the installers and
the release note (changelog entry + [`RELEASE_NOTES.md`](RELEASE_NOTES.md))
attached. Nothing needs to be created or edited in the GitHub UI.

1. Make sure everything that should ship is merged into `main`, and that
   `CHANGELOG.md` says under `## [Unreleased]` what is new for a user.
2. Run the release script with the next version
   ([semantic versioning](https://semver.org/spec/v2.0.0.html)):

   ```bash
   ./release.sh 1.3.0
   ```

   It sets the Maven version of every `javafx/` module to `1.3.0` (that is
   also the version the installers report to the OS), commits that, tags
   `v1.3.0` and pushes `main` and the tag. It refuses when the tree is dirty,
   `main` differs from `origin/main`, the tag already exists or is older than
   the latest one, or the changelog has nothing to say (`--allow-empty-changelog`
   overrides that last one). `--dry-run` does everything except push.
3. Watch the build at
   [Actions → release](https://github.com/mindconnect-ai/mc-clients/actions/workflows/release.yml)
   (about 10–15 minutes; the Windows and Intel Mac runners are the slow ones).
   The release shows up on the [releases page](https://github.com/mindconnect-ai/mc-clients/releases)
   as soon as the first installer job finishes and fills up as the others do.
4. `git pull` afterwards — the workflow has pushed the frozen changelog to `main`.

The Maven version is the release version, with no `-SNAPSHOT` in between:
`main` builds as the last release until the script moves it on, because the
installers take their version from the POM and `jpackage` refuses a
`-SNAPSHOT`. Nothing from this repository is deployed to a Maven repository,
so a non-snapshot version on `main` costs nothing.

If a build fails after the tag is pushed, fix `main`, delete the tag locally
and on origin (`git tag -d v1.3.0 && git push origin :v1.3.0`), delete the
half-made release on GitHub if one was created, and run the script again.
