import * as path from "node:path";
import * as vscode from "vscode";

export const PROPOSAL_SCHEME = "mindconnect-proposal";

export type Decision =
  | { kind: "accepted"; saved: boolean }
  | { kind: "rejected" }
  | { kind: "conflict"; reason: string };

interface Proposal {
  id: string;
  target: vscode.Uri;
  /** The text the proposal was computed from — the buffer if open, else the disk; null for a new file. */
  base: string | null;
  proposed: string;
  decide: (d: Decision) => void;
  decided: Promise<Decision>;
}

/**
 * Changes the agent proposes, shown as a diff: left the file as it is now
 * (the live buffer, unsaved changes included), right the proposal. Nothing is
 * written until the user accepts — then the change goes in as a WorkspaceEdit,
 * so undo, dirty buffers and formatting-on-save behave as with any other edit.
 */
export class ProposalManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly proposals = new Map<string, Proposal>();
  private readonly disposables: vscode.Disposable[] = [];
  private next = 1;

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this),
      vscode.commands.registerCommand("mindconnect.proposal.accept", (uri?: vscode.Uri) => this.decideFrom(uri, true)),
      vscode.commands.registerCommand("mindconnect.proposal.reject", (uri?: vscode.Uri) => this.decideFrom(uri, false)),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const [id, side] = uri.path.split("/").filter(Boolean);
    const proposal = this.proposals.get(id);
    if (!proposal) return "";
    return side === "base" ? proposal.base ?? "" : proposal.proposed;
  }

  /**
   * Shows the diff and resolves with the user's decision — whenever it comes;
   * the caller decides how long to wait for it. A proposal stays open until
   * decided, so accepting after the caller gave up still applies it.
   */
  async propose(target: vscode.Uri, base: string | null, proposed: string): Promise<Decision> {
    const id = String(this.next++);
    let decide!: (d: Decision) => void;
    const decided = new Promise<Decision>((resolve) => (decide = resolve));
    const proposal: Proposal = { id, target, base, proposed, decide, decided };
    this.proposals.set(id, proposal);

    const name = path.basename(target.fsPath);
    const right = this.uri(id, "proposed", name);
    const left = base === null ? this.uri(id, "base", name) : target;
    const title = `${name} ${base === null ? "(new file)" : ""} ↔ MindConnect proposal`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: false });

    // The editor title carries Accept / Reject too; the notification is for when the diff is out of view.
    void vscode.window
      .showInformationMessage(`MindConnect proposes a change to ${vscode.workspace.asRelativePath(target)}.`, "Accept", "Reject")
      .then((choice) => {
        if (choice && this.proposals.has(id)) void this.decide(proposal, choice === "Accept");
      });
    return decided;
  }

  dispose(): void {
    for (const p of this.proposals.values()) p.decide({ kind: "rejected" });
    this.proposals.clear();
    this.disposables.forEach((d) => d.dispose());
  }

  private uri(id: string, side: "base" | "proposed", name: string): vscode.Uri {
    // The file name at the end gives the diff editor the right language.
    return vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${id}/${side}/${name}` });
  }

  /** From the editor title button (uri given) or the command palette (the active diff). */
  private async decideFrom(uri: vscode.Uri | undefined, accept: boolean): Promise<void> {
    const target = uri ?? activeProposalUri();
    const id = target?.scheme === PROPOSAL_SCHEME ? target.path.split("/").filter(Boolean)[0] : undefined;
    const proposal = id ? this.proposals.get(id) : undefined;
    if (!proposal) {
      void vscode.window.showWarningMessage("No open MindConnect proposal here.");
      return;
    }
    await this.decide(proposal, accept);
  }

  private async decide(proposal: Proposal, accept: boolean): Promise<void> {
    this.proposals.delete(proposal.id);
    await closeDiff(proposal.id);
    if (!accept) {
      proposal.decide({ kind: "rejected" });
      return;
    }
    try {
      proposal.decide(await apply(proposal));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Could not apply the change: ${reason}`);
      proposal.decide({ kind: "conflict", reason });
    }
  }
}

/** Writes an accepted proposal through the editor — only the part that differs, so cursor and folds stay. */
async function apply(proposal: Proposal): Promise<Decision> {
  const edit = new vscode.WorkspaceEdit();
  let doc: vscode.TextDocument;
  if (proposal.base === null) {
    edit.createFile(proposal.target, { overwrite: false, ignoreIfExists: true });
    edit.insert(proposal.target, new vscode.Position(0, 0), proposal.proposed);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code refused the edit.");
    doc = await vscode.workspace.openTextDocument(proposal.target);
  } else {
    doc = await vscode.workspace.openTextDocument(proposal.target);
    const current = doc.getText();
    if (current !== proposal.base) {
      return { kind: "conflict", reason: "the file changed while the proposal was open" };
    }
    const { start, endOld, endNew } = changedSpan(current, proposal.proposed);
    edit.replace(proposal.target, new vscode.Range(doc.positionAt(start), doc.positionAt(endOld)), proposal.proposed.slice(start, endNew));
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code refused the edit.");
  }
  // The agent's other tools read the disk — save so they see what the user accepted.
  const saved = await doc.save();
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
  return { kind: "accepted", saved };
}

/** Offsets of the one span in which two texts differ: common prefix and suffix cut away. */
function changedSpan(a: string, b: string): { start: number; endOld: number; endNew: number } {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endOld = a.length;
  let endNew = b.length;
  while (endOld > start && endNew > start && a.charCodeAt(endOld - 1) === b.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return { start, endOld, endNew };
}

function activeProposalUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
}

async function closeDiff(id: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
    const input = t.input;
    return input instanceof vscode.TabInputTextDiff
      && input.modified.scheme === PROPOSAL_SCHEME
      && input.modified.path.split("/").filter(Boolean)[0] === id;
  });
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}
