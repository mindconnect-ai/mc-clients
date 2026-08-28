## MindConnect Admin Launcher

A small desktop app that runs the MindConnect agent server: download a
released server from Maven Central, pick a version, configure the
environment (encryption key included), start / stop — and jump straight
into the Admin UI in your browser.

### Downloads

| File | For |
|------|-----|
| `…-mac-aarch64.dmg` | macOS on Apple silicon (M1 and later) |
| `…-mac-x64.dmg` | macOS on Intel |
| `…-windows-x64.msi` | Windows |
| `…-linux-x64.deb` | Debian/Ubuntu |
| `…-<platform>-all.jar` | Any OS with a Java 21+ runtime: `java -jar <file>` |

The installers bundle their own Java runtime — nothing to install first.

### macOS: "Apple could not verify …"

The app is not yet notarized with Apple, so the first launch is blocked by
Gatekeeper. Two ways around it:

1. **System Settings** → *Privacy & Security* → scroll down to
   *"MindConnect Admin Launcher was blocked …"* → **Open Anyway**
   (the dialog's own buttons only offer *Move to Trash* / *Done* — use the
   settings path instead), **or**
2. use the jar instead — `java -jar mindconnect-admin-launcher-<version>-mac-aarch64-all.jar`
   needs no Gatekeeper exception (requires a Java 21+ runtime, e.g.
   `brew install temurin@21`), **or**
3. remove the quarantine flag once:
   `xattr -d com.apple.quarantine "/Applications/MindConnect Admin Launcher.app"`

Notarized builds are on the roadmap.

### Windows

SmartScreen may warn about an unknown publisher on first run — choose
*More info* → *Run anyway*.
