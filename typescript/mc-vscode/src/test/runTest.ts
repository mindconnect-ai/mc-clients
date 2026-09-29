import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

/**
 * Starts a separate VS Code (downloaded into .vscode-test on first run) on the
 * fixture workspace with only this extension's tests — no other extensions,
 * a throwaway profile.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, "suite/index"),
    launchArgs: [
      path.join(extensionDevelopmentPath, "test-fixtures", "workspace"),
      "--disable-extensions",
      "--user-data-dir", path.join(os.tmpdir(), "mc-vscode-test-profile"),
    ],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
