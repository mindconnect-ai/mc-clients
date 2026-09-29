import * as vscode from "vscode";

const SECRET_ENV = "mindconnect.server.secretEnv";

/** Names whose values are credentials — kept in the secret storage, never in settings.json. */
export function looksSecret(name: string): boolean {
  return /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(name);
}

export interface EnvEntry {
  name: string;
  /** Empty for a secret — its value never leaves the extension host. */
  value: string;
  secret: boolean;
}

/**
 * The managed server's extra environment: plain variables in the setting
 * mindconnect.server.env (visible, syncable), secret ones — API keys — in
 * VS Code's secret storage (the OS keychain).
 */
export class EnvStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Everything the server process gets, secrets included. */
  async resolved(): Promise<Record<string, string>> {
    return { ...this.plain(), ...(await this.secretValues()) };
  }

  /** For display: secrets by name only. */
  async entries(): Promise<EnvEntry[]> {
    const plain = Object.entries(this.plain()).map(([name, value]) => ({ name, value, secret: false }));
    const secret = Object.keys(await this.secretValues()).map((name) => ({ name, value: "", secret: true }));
    return [...plain, ...secret].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Replaces the whole environment. A secret row with an empty value keeps
   * the value stored before — the form never has it to send back.
   */
  async save(rows: EnvEntry[]): Promise<void> {
    const before = await this.secretValues();
    const plain: Record<string, string> = {};
    const secret: Record<string, string> = {};
    for (const row of rows) {
      const name = row.name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      if (row.secret) {
        const value = row.value || before[name];
        if (value) secret[name] = value;
      } else {
        plain[name] = row.value;
      }
    }
    await vscode.workspace.getConfiguration("mindconnect.server").update("env", plain, vscode.ConfigurationTarget.Global);
    await this.secrets.store(SECRET_ENV, JSON.stringify(secret));
  }

  private plain(): Record<string, string> {
    return vscode.workspace.getConfiguration("mindconnect.server").get<Record<string, string>>("env") ?? {};
  }

  private async secretValues(): Promise<Record<string, string>> {
    try {
      return JSON.parse((await this.secrets.get(SECRET_ENV)) ?? "{}");
    } catch {
      return {};
    }
  }
}
