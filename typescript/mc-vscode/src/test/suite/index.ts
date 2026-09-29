import * as path from "node:path";
import Mocha from "mocha";

/** Entry point VS Code's test runner calls inside the extension host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true });
  mocha.addFile(path.resolve(__dirname, "backchannel.test.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
