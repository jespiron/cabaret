// Run with node --test vscode/test/navigation.node.mjs after building @cabaret/node.
// Exercise real Git/native data through an editor stub; no GUI or downloads required.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { after, test } from "node:test";
const require = createRequire(new URL("../package.json", import.meta.url));
const { transformSync } = require("esbuild");
const { Cabaret, discoverRepositories } = require("@cabaret/node");
const root = realpathSync(mkdtempSync("/tmp/cabaret-navigation-"));
after(() => rmSync(root, { recursive: true, force: true }));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  CODEX_HOME: join(root, "codex"),
};
function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, env, stdio: "pipe" }).toString().trim();
}
async function fixture(name) {
  const main = join(root, name);
  mkdirSync(main);
  git(main, "init", "--initial-branch=main");
  git(main, "config", "cabaret.prefix", "");
  writeFileSync(join(main, "file.txt"), name);
  git(main, "add", ".");
  git(main, "commit", "-m", "initial");
  const cab = new Cabaret(main);
  await cab.create("feature", "main");
  const feature = join(root, `${name}-feature`);
  git(main, "worktree", "add", feature, "feature");
  await cab.setDescription("feature", name);
  return { main, feature, cab };
}
// Native methods consult the process environment too.
Object.assign(process.env, env);
const a = await fixture("alpha"),
  b = await fixture("beta");
class Uri {
  constructor(scheme, path, query = "") {
    Object.assign(this, { scheme, path, query, fsPath: path });
  }
  static file(path) {
    return new Uri("file", path);
  }
  static from({ scheme, path, query }) {
    return new Uri(scheme, path, query);
  }
  static parse(text) {
    const i = text.indexOf(":");
    const [path, query = ""] = text.slice(i + 1).split("?");
    return new Uri(text.slice(0, i), path, query);
  }
  static joinPath(uri, path) {
    return new Uri(uri.scheme, join(uri.path, path));
  }
  toString() {
    return `${this.scheme}:${this.path}${this.query ? "?" + this.query : ""}`;
  }
}
class Disposable {
  dispose() {}
  static from() {
    return new Disposable();
  }
}
class EventEmitter {
  event = () => new Disposable();
  fire() {}
  dispose() {}
}
const commands = new Map();
let picks = 0;
let choose;
let lastItems;
const menus = [];
const vscode = {
  Uri,
  Disposable,
  EventEmitter,
  ThemeColor: class {},
  RelativePattern: class {},
  Range: class {},
  TabInputText: class {},
  TabInputTextDiff: class {},
  TabInputTextMultiDiff: class {},
  QuickPickItemKind: { Separator: -1 },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(root) }],
    textDocuments: [],
    createFileSystemWatcher: () => ({
      dispose() {},
      onDidCreate: () => new Disposable(),
      onDidChange: () => new Disposable(),
      onDidDelete: () => new Disposable(),
    }),
  },
  window: {
    tabGroups: { activeTabGroup: {} },
    activeTextEditor: undefined,
    createTextEditorDecorationType: () => new Disposable(),
    showErrorMessage: (message) => {
      throw new Error(message);
    },
    showQuickPick: async (items) => {
      picks++;
      lastItems = items;
      menus.push(items);
      return choose?.(items);
    },
  },
  commands: {
    registerCommand: (name, fn) => {
      commands.set(name, fn);
      return new Disposable();
    },
  },
};
const source =
  readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8") +
  "\nexport { repositoryForUri, repositoryAt, routeUri, blobUri, descriptionUri, ensureRepository, pickWorkspace, onChange, PageProvider, BlobProvider, DescriptionProvider, showWorkspacePicker, stepOut };";
const code = transformSync(source, { loader: "ts", format: "cjs", target: "node22" }).code;
const module = { exports: {} };
vm.runInNewContext(code, {
  module,
  exports: module.exports,
  require: (name) => (name === "vscode" ? vscode : require(name)),
  URLSearchParams,
  Buffer,
  console,
  setTimeout,
  clearTimeout,
});
const ext = module.exports;
function chooseWorktree(path) {
  return (items) =>
    items.find((item) => item.dir === path || item.worktrees?.some((worktree) => worktree.dir === path));
}

function activeFile(path) {
  vscode.window.activeTextEditor = { document: { uri: Uri.file(path) } };
}

test("summon follows active files across repositories and never asks for a workspace", async () => {
  const opened = [];
  const provider = { open: async (route, cab) => opened.push([route.change, cab.commonDir()]) };
  ext.onChange("show", provider, (cab, change) => provider.open({ kind: "show", change }, cab));
  activeFile(join(a.feature, "file.txt"));
  await commands.get("show")();
  activeFile(join(b.feature, "file.txt"));
  await commands.get("show")();
  assert.deepEqual(opened, [
    ["feature", a.cab.commonDir()],
    ["feature", b.cab.commonDir()],
  ]);
  assert.equal(picks, 0);
});

test("unowned file selects project then worktree; cancelling without an active editor is harmless", async () => {
  writeFileSync(join(root, "notes.txt"), "notes");
  activeFile(join(root, "notes.txt"));
  choose = chooseWorktree(b.feature);
  const opened = [];
  const provider = { open: async (route, cab) => opened.push([route.change, cab.commonDir()]) };
  ext.onChange("pick-show", provider, (cab, change) => provider.open({ kind: "show", change }, cab));
  await commands.get("pick-show")();
  assert.equal(picks, 2);
  assert.deepEqual(opened, [["feature", b.cab.commonDir()]]);
  assert.equal(menus[0].filter((i) => i.choice === "project").length, 2);
  assert.equal(lastItems.filter((i) => i.choice === "worktree").length, 2);
  assert.ok(lastItems.filter((i) => i.dir).every((i) => i.dir === b.main || i.dir === b.feature));
  vscode.window.activeTextEditor = undefined;
  choose = undefined;
  await commands.get("pick-show")();
  assert.equal(picks, 3);
  assert.equal(opened.length, 1);
});

test("same-named change pages, diff blobs, and editable descriptions retain independent repositories", async () => {
  const ac = ext.repositoryAt(a.feature),
    bc = ext.repositoryAt(b.feature);
  const au = ext.routeUri({ kind: "show", change: "feature" }, ac),
    bu = ext.routeUri({ kind: "show", change: "feature" }, bc);
  assert.notEqual(au.toString(), bu.toString());
  activeFile(join(b.feature, "file.txt"));
  assert.equal((await ext.ensureRepository(au)).commonDir(), a.cab.commonDir());
  const provider = new ext.PageProvider();
  try {
    const [ap, bp] = await Promise.all([
      provider.provideTextDocumentContent(au),
      provider.provideTextDocumentContent(bu),
    ]);
    assert.ok(ap.includes(a.feature));
    assert.ok(bp.includes(b.feature));
    const descriptions = new ext.DescriptionProvider();
    const ad = ext.descriptionUri("feature", ac),
      bd = ext.descriptionUri("feature", bc);
    await descriptions.writeFile(ad, Buffer.from("alpha edited"));
    assert.equal((await descriptions.readFile(ad)).toString(), "alpha edited");
    assert.equal((await descriptions.readFile(bd)).toString(), "beta");
    const blobs = new ext.BlobProvider();
    const diff = { view: "diff", change: "feature", path: "file.txt", tip: git(a.feature, "rev-parse", "HEAD") };
    const blobA = ext.blobUri(diff, diff.tip, "file.txt", ac);
    const tipB = git(b.feature, "rev-parse", "HEAD");
    const blobB = ext.blobUri({ ...diff, tip: tipB }, tipB, "file.txt", bc);
    assert.equal(await blobs.provideTextDocumentContent(blobA), "alpha");
    assert.equal(await blobs.provideTextDocumentContent(blobB), "beta");
  } finally {
    provider.dispose();
  }
});

test("picker can move from one repository overview to another in the same window", async () => {
  const ac = ext.repositoryAt(a.feature);
  vscode.window.activeTextEditor = { document: { uri: ext.routeUri({ kind: "show", change: "feature" }, ac) } };
  choose = chooseWorktree(b.feature);
  let opened;
  await ext.stepOut(ac, {
    open: async (route, cab) => {
      opened = [route.change, cab.commonDir()];
    },
  });
  assert.deepEqual(opened, ["feature", b.cab.commonDir()]);
});

test("old unqualified tabs are refused in a mixed container", async () => {
  await assert.rejects(ext.ensureRepository(Uri.parse("cabaret:/show/feature")), /no repository identity/);
});

test("moved main and linked checkouts work after git worktree repair", async () => {
  const original = await fixture("movable");
  const moved = join(root, "relocated");
  mkdirSync(moved);
  const main = join(moved, "main"),
    feature = join(moved, "feature");
  renameSync(original.main, main);
  renameSync(original.feature, feature);
  git(main, "worktree", "repair", feature);
  assert.deepEqual(await discoverRepositories(moved), [main]);
  const cab = await ext.repositoryForUri(Uri.file(join(feature, "file.txt")));
  assert.equal(await cab.currentChange(), "feature");
  const entries = await cab.workspaceEntries();
  assert.ok(entries.some((e) => e.path === feature));
  const page = await cab.showPage("feature");
  assert.ok(
    page.lines
      .flatMap((l) => l.segments.map((s) => s.text))
      .join("")
      .includes(feature),
  );
});

test("multiple workspace folders do not duplicate repository groups", async () => {
  const original = vscode.workspace.workspaceFolders;
  try {
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(root) }, { uri: Uri.file(a.feature) }];
    choose = undefined;
    await ext.pickWorkspace();
    // The final move test introduced a third repository beneath relocated/; shallow
    // discovery does not recurse into that directory.
    assert.equal(lastItems.filter((i) => i.choice === "project").length, 2);
    assert.equal(lastItems.flatMap((i) => i.worktrees ?? [i]).filter((i) => i.dir === a.feature).length, 1);
  } finally {
    vscode.workspace.workspaceFolders = original;
  }
});

test("single-worktree project opens directly beside expandable projects", async () => {
  const single = await fixture("single");
  git(single.main, "worktree", "remove", single.feature);
  const before = picks;
  choose = (items) => items.find((item) => item.choice === "worktree" && item.dir === single.main);
  const selected = await ext.pickWorkspace();
  assert.equal(selected.commonDir(), single.cab.commonDir());
  assert.equal(picks - before, 1);
  const item = lastItems.find((item) => item.dir === single.main);
  assert.equal(item.label, "main");
  assert.equal(item.description, "single");
  assert.ok(lastItems.some((item) => item.choice === "project" && item.label === "alpha"));
});

test("back from worktree choices returns to projects and allows another project", async () => {
  const before = picks;
  let stage = 0;
  choose = (items) => {
    switch (stage++) {
      case 0:
        return items.find((item) => item.choice === "project" && item.label === "alpha");
      case 1:
        return items.find((item) => item.choice === "back");
      case 2:
        return items.find((item) => item.choice === "project" && item.label === "beta");
      case 3:
        return items.find((item) => item.dir === b.feature);
      default:
        throw new Error("unexpected picker step");
    }
  };
  const selected = await ext.pickWorkspace();
  assert.equal(selected.commonDir(), b.cab.commonDir());
  assert.equal(picks - before, 4);
});

test("cancelling the worktree step opens no change", async () => {
  let stage = 0;
  choose = (items) => (stage++ === 0 ? items.find((item) => item.choice === "project") : undefined);
  let opened = false;
  await ext.showWorkspacePicker({
    open: async () => {
      opened = true;
    },
  });
  assert.equal(opened, false);
  assert.equal(stage, 2);
});
