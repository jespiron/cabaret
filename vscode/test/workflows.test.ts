import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

/** Every tab, the active one marked, then the cursor's line in the active editor. */
function screen(): string {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const lines = tabs.map((tab) => `${tab.isActive ? ">" : " "} ${tab.label}`);
  const editor = vscode.window.activeTextEditor;
  if (editor !== undefined) {
    const { uri } = editor.document;
    const { line } = editor.selection.active;
    // Without the query, which holds revisions that differ from run to run.
    lines.push(`${uri.scheme}:${uri.path}:${line}: ${editor.document.lineAt(line).text}`.trimEnd());
  }
  return lines.map((line) => `  ${line}\n`).join("");
}

/** Put the cursor on the active editor's first occurrence of `text`. */
function cursorTo(text: string): void {
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, "no active editor");
  const lines = editor.document.getText().split("\n");
  const line = lines.findIndex((candidate) => candidate.includes(text));
  const found = lines[line];
  assert.ok(found !== undefined, `no line contains ${JSON.stringify(text)} in\n${lines.join("\n")}`);
  const position = new vscode.Position(line, found.indexOf(text));
  editor.selection = new vscode.Selection(position, position);
}

/**
 * Commands run one after another, each with the cursor first moved onto some text, and the screen
 * after each, so a whole workflow is compared at once.
 */
async function transcript(steps: [command: string, at?: string][]): Promise<string> {
  let out = "";
  for (const [command, at] of steps) {
    if (at !== undefined) {
      cursorTo(at);
    }
    await vscode.commands.executeCommand(command);
    out += `${command}${at === undefined ? "" : ` at ${JSON.stringify(at)}`}\n${screen()}`;
  }
  return out;
}

// The tests share the fixture of `.vscode-test.mjs`, and run in order.
suite("workflows", () => {
  setup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("moving between pages and file diffs replaces a single tab", async () => {
    const actual = await transcript([
      ["cabaret.home"],
      ["cabaret.stepIn", "feature"],
      ["cabaret.diff"],
      ["cabaret.stepIn", "a.txt"],
      ["cabaret.stepDown"],
      ["cabaret.stepOut"],
      ["cabaret.stepOut"],
      ["cabaret.home"],
    ]);
    assert.equal(
      actual,
      `cabaret.home
  > review
  cabaret:/home/review:0:  ╭──────────┬─────────┬──────────────╮
cabaret.stepIn at "feature"
  > feature
  cabaret:/show/feature:0: feature
cabaret.diff
  > feature
  cabaret:/diff/feature:6: ├─○ a.txt +1 -0
cabaret.stepIn at "a.txt"
  > src/a.txt (feature)
  cabaret-blob:/src/a.txt:0: a
cabaret.stepDown
  > src/b.txt (feature)
  cabaret-blob:/src/b.txt:0: b
cabaret.stepOut
  > feature
  cabaret:/diff/feature:6: ├─○ a.txt +1 -0
cabaret.stepOut
  > feature
  cabaret:/show/feature:0: feature
cabaret.home
  > review
  cabaret:/home/review:4: ○   feature
`,
    );
  });

  test("marking file diffs reviewed moves through review to its emptied page", async () => {
    const actual = await transcript([
      ["cabaret.home"],
      ["cabaret.stepIn", "feature"],
      ["cabaret.review"],
      ["cabaret.stepIn", "a.txt"],
      ["cabaret.mark"],
      ["cabaret.mark"],
    ]);
    assert.equal(
      actual,
      `cabaret.home
  > review
  cabaret:/home/review:4: ○   feature
cabaret.stepIn at "feature"
  > feature
  cabaret:/show/feature:0: feature
cabaret.review
  > feature
  cabaret:/review/feature:6: ├─○ a.txt +1 -0
cabaret.stepIn at "a.txt"
  > src/a.txt (feature, unreviewed)
  cabaret-blob:/src/a.txt:0: a
cabaret.mark
  > src/b.txt (feature, unreviewed)
  cabaret-blob:/src/b.txt:0: b
cabaret.mark
  > feature
  cabaret:/review/feature:6:
`,
    );
  });

  test("workspace file diffs show what was saved as they opened", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "no workspace folder");
    const file = join(folder.uri.fsPath, "src/a.txt");
    writeFileSync(file, "a, saved\n");
    try {
      const actual = await transcript([
        ["cabaret.home"],
        ["cabaret.stepIn", "workspaces"],
        ["cabaret.stepIn", "feature"],
        ["cabaret.workspaceDiff"],
        ["cabaret.stepIn", "a.txt"],
      ]);
      assert.equal(
        actual,
        `cabaret.home
  > review
  cabaret:/home/review:4: nothing awaiting review by test@example.com
cabaret.stepIn at "workspaces"
  > workspaces
  cabaret:/home/workspaces:0:  ╭──────────┬─────────┬──────────────╮
cabaret.stepIn at "feature"
  > feature
  cabaret:/show/feature:0: feature
cabaret.workspaceDiff
  > feature
  cabaret:/workspace/feature:5: ○ src/a.txt +1 -1
cabaret.stepIn at "a.txt"
  > src/a.txt (feature, uncommitted)
  cabaret-blob:/src/a.txt:0: a, saved
`,
      );
      writeFileSync(file, "a, saved again\n");
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, "no active editor");
      assert.equal(editor.document.getText(), "a, saved\n");
    } finally {
      writeFileSync(file, "a\n");
    }
  });

  test("page coming back into view shows what changed while it was hidden", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "no workspace folder");
    const file = join(folder.uri.fsPath, "src/a.txt");
    await transcript([
      ["cabaret.home"],
      ["cabaret.stepIn", "workspaces"],
      ["cabaret.stepIn", "feature"],
      ["cabaret.workspaceDiff"],
    ]);
    const page = vscode.window.activeTextEditor?.document;
    assert.ok(page, "no active editor");
    const before = page.getText();
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, "README.md"), { preview: false });
    // Behind VS Code's back, as an agent in a terminal would.
    writeFileSync(file, "a, edited\n");
    try {
      const updated = new Promise<void>((resolve) => {
        const listener = vscode.workspace.onDidChangeTextDocument(({ document }) => {
          if (document === page) {
            listener.dispose();
            resolve();
          }
        });
      });
      await vscode.window.showTextDocument(page);
      await updated;
      assert.equal(
        `${before}---\n${page.getText()}`,
        `feature · uncommitted files
 ╭──────────┬────────────┬──────────────┬─────────────────╮
 │ overview │ [d] diff 2 │ [r] review 0 │ [w] workspace 0 │
─┴──────────┴────────────┴──────────────┘                 └─

no uncommitted files
---
feature · uncommitted files
 ╭──────────┬────────────┬──────────────┬─────────────────╮
 │ overview │ [d] diff 2 │ [r] review 0 │ [w] workspace 1 │
─┴──────────┴────────────┴──────────────┘                 └─

○ src/a.txt +1 -1
`,
      );
    } finally {
      writeFileSync(file, "a\n");
    }
  });

  test("page in view follows commits made elsewhere", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "no workspace folder");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: folder.uri.fsPath, stdio: "ignore" });
    await transcript([["cabaret.home"], ["cabaret.stepIn", "feature"], ["cabaret.diff"]]);
    const page = vscode.window.activeTextEditor?.document;
    assert.ok(page, "no active editor");
    const before = page.getText();
    const updated = new Promise<void>((resolve) => {
      const listener = vscode.workspace.onDidChangeTextDocument(({ document }) => {
        if (document === page) {
          listener.dispose();
          resolve();
        }
      });
    });
    writeFileSync(join(folder.uri.fsPath, "src/c.txt"), "c\n");
    // Behind VS Code's back, as an agent in a terminal would.
    git("add", "src/c.txt");
    git("commit", "--message=c");
    try {
      await updated;
      assert.equal(
        `${before}---\n${page.getText()}`,
        `feature · changed files
 ╭──────────┬────────────┬──────────────┬─────────────────╮
 │ overview │ [d] diff 2 │ [r] review 0 │ [w] workspace 0 │
─┴──────────┘            └──────────────┴─────────────────┴─

◌ src/ +2 -0
├─○ a.txt +1 -0
╰─○ b.txt +1 -0
---
feature · changed files
 ╭──────────┬────────────┬──────────────┬─────────────────╮
 │ overview │ [d] diff 3 │ [r] review 1 │ [w] workspace 0 │
─┴──────────┘            └──────────────┴─────────────────┴─

◌ src/ +3 -0
├─○ a.txt +1 -0
├─○ b.txt +1 -0
╰─○ c.txt +1 -0
`,
      );
    } finally {
      git("reset", "--hard", "HEAD~1");
    }
  });

  test("saving an unchanged description succeeds", async () => {
    const description = vscode.Uri.from({ scheme: "cabaret-description", path: "/feature.md" });
    const save = (text: string) => vscode.workspace.fs.writeFile(description, Buffer.from(text));
    await save("Described.\n");
    await save("Described.\n");
    await save("");
    await save("");
  });
});
