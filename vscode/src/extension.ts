import {
  Cabaret,
  discoverRepositories,
  type ChangedFile,
  type ChangeId,
  type Page,
  type RepoPath,
  type RevisionId,
  type Safeguard,
  type SafeguardKind,
  type Segment,
  type SessionId,
  type Tag,
  type Target,
  type DiffView,
  type Fold,
  type HomeSection,
  type WorkspaceId,
} from "@cabaret/node";
import * as vscode from "vscode";
import { basename, dirname } from "node:path";
import { realpathSync } from "node:fs";

// TODO-someday(joel): ensure unicode glyph appearance is okay on linux and windows.

const SCHEME = "cabaret";
const BLOB_SCHEME = "cabaret-blob";
const DESCRIPTION_SCHEME = "cabaret-description";
/** The language of pages, whose `configurationDefaults` close line gaps in their box drawing. */
const PAGE_LANGUAGE = "cabaret";

/** Each checkout has its own context; virtual documents carry it in their URI. */
const repositories = new Map<string, Cabaret>();
const repositoryPaths = new WeakMap<Cabaret, string>();

function repositoryAt(dir: string): Cabaret {
  const path = realpathSync(dir);
  let cabaret = repositories.get(path);
  if (cabaret === undefined) {
    cabaret = new Cabaret(path);
    repositories.set(path, cabaret);
    repositoryPaths.set(cabaret, path);
  }
  return cabaret;
}

function repositoryPath(cabaret: Cabaret): string {
  const path = repositoryPaths.get(cabaret);
  if (path === undefined) throw new Error("repository context is missing");
  return path;
}

function repositoryQuery(cabaret: Cabaret): string {
  return new URLSearchParams({ repository: repositoryPath(cabaret) }).toString();
}

function activeRepositoryUri(): vscode.Uri | undefined {
  const diff = tabFileDiffs(vscode.window.tabGroups.activeTabGroup.activeTab)[0];
  return diff?.sides.modified ?? vscode.window.activeTextEditor?.document.uri;
}

/** Resolve the specific document, never the repository chosen by an earlier command. */
async function repositoryForUri(uri: vscode.Uri): Promise<Cabaret | undefined> {
  if ([SCHEME, BLOB_SCHEME, DESCRIPTION_SCHEME].includes(uri.scheme)) {
    const path = new URLSearchParams(uri.query).get("repository");
    if (path !== null) return repositoryAt(path);
    // Old tabs carry no repository identity. Only restore them in an unambiguous checkout.
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) {
      try {
        return repositoryAt(folders[0]!.uri.fsPath);
      } catch {
        /* container */
      }
    }
    throw new Error(
      "this older Cabaret tab has no repository identity; close it and reopen Cabaret from a worktree file",
    );
  }
  if (uri.scheme !== "file") return undefined;
  try {
    // Git discovery walks upward from the file, never sideways into sibling worktrees.
    const candidate = new Cabaret(dirname(uri.fsPath));
    const path = await candidate.workspacePath(await candidate.currentChange());
    return repositoryAt(path);
  } catch {
    return undefined;
  }
}

async function repositoryChoices(): Promise<{ label: string; description: string; dir: string }[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates = await Promise.all(folders.map((folder) => discoverRepositories(folder.uri.fsPath)));
  const grouped = new Map<string, string>();
  for (const dir of candidates.flat()) grouped.set(repositoryAt(dir).commonDir(), dir);
  return [...grouped.values()].sort().map((dir) => ({ label: basename(dir), description: dir, dir }));
}

type WorktreeChoice = vscode.QuickPickItem & {
  choice: "worktree";
  dir: string;
  change?: ChangeId | null;
};

type ProjectChoice = vscode.QuickPickItem & {
  choice: "project";
  worktrees: WorktreeChoice[];
};

/** Skip project selection for one project; in mixed folders, expand only projects with several worktrees. */
async function pickWorkspace(): Promise<Cabaret | undefined> {
  const projects = await Promise.all(
    (await repositoryChoices()).map(async (repo): Promise<ProjectChoice | WorktreeChoice | undefined> => {
      const entries = await repositoryAt(repo.dir).workspaceEntries();
      const worktrees: WorktreeChoice[] = entries.map((entry) => ({
        choice: "worktree",
        label: entry.change ?? "(detached HEAD)",
        description: basename(entry.path),
        detail: entry.path,
        dir: entry.path,
        change: entry.change,
      }));
      if (worktrees.length === 0) return undefined;
      if (worktrees.length === 1) return { ...worktrees[0]!, description: repo.label };
      return {
        choice: "project",
        label: repo.label,
        description: `${worktrees.length} worktrees`,
        detail: repo.dir,
        worktrees,
      };
    }),
  );
  const choices = projects.filter((item) => item !== undefined);
  const only = choices.length === 1 ? choices[0] : undefined;
  const items = only?.choice === "project" ? only.worktrees : choices;
  const options = { matchOnDescription: true, matchOnDetail: true };
  const back = { choice: "back" as const, label: "$(arrow-left) Back to projects", alwaysShow: true };
  while (true) {
    const selected = await vscode.window.showQuickPick(items, {
      ...options,
      title: "Cabaret: Open Worktree",
      placeHolder:
        items.length === 0
          ? "No worktrees found"
          : only === undefined
            ? "Choose a project or worktree"
            : "Choose a worktree to review",
    });
    if (selected === undefined) return undefined;
    let picked: WorktreeChoice;
    if (selected.choice === "project") {
      const worktree = await vscode.window.showQuickPick([back, ...selected.worktrees], {
        ...options,
        title: `Cabaret: ${selected.label}`,
        placeHolder: "Choose a worktree to review",
      });
      if (worktree === undefined) return undefined;
      if (worktree.choice === "back") continue;
      picked = worktree;
    } else {
      picked = selected;
    }
    if (!picked.change) throw new Error("this worktree has detached HEAD; check out a branch to review its change");
    return repositoryAt(picked.dir);
  }
}

async function ensureRepository(uri: vscode.Uri): Promise<Cabaret> {
  const cabaret = await repositoryForUri(uri);
  if (cabaret === undefined) throw new Error("this document does not belong to a Git worktree");
  return cabaret;
}

async function showWorkspacePicker(provider: PageProvider): Promise<void> {
  const cabaret = await pickWorkspace();
  if (cabaret !== undefined) await provider.open({ kind: "show", change: await cabaret.currentChange() }, cabaret);
}

/** Every `DiffView`; the `satisfies` stops compiling until a new view is listed here. */
const DIFF_VIEWS = Object.keys({ diff: true, review: true, workspace: true } satisfies Record<DiffView, true>);

function isDiffView(text: string | null | undefined): text is DiffView {
  return DIFF_VIEWS.some((view) => view === text);
}

/** The views whose sides are both committed. */
type CommittedView = Exclude<DiffView, "workspace">;

/** Every `HomeSection`; the `satisfies` stops compiling until a new section is listed here. */
const HOME_SECTIONS = Object.keys({ review: true, owned: true, workspaces: true } satisfies Record<HomeSection, true>);

function isHomeSection(text: string | undefined): text is HomeSection {
  return HOME_SECTIONS.some((section) => section === text);
}

type Route = { kind: "home"; section: HomeSection } | { kind: "show" | DiffView; change: ChangeId };

function routeUri(route: Route, cabaret: Cabaret): vscode.Uri {
  const path = `/${route.kind}/${route.kind === "home" ? route.section : route.change}`;
  return vscode.Uri.from({ scheme: SCHEME, path, query: repositoryQuery(cabaret) });
}

function parseRoute(uri: vscode.Uri): Route {
  const [, kind, rest] = /^\/([^/]+)\/(.+)$/.exec(uri.path) ?? [];
  if (kind === "home" && isHomeSection(rest)) {
    return { kind, section: rest };
  }
  if ((kind === "show" || isDiffView(kind)) && rest !== undefined) {
    return { kind, change: rest };
  }
  throw new Error(`unknown page ${uri.toString()}`);
}

/** A file in the workspace, as Enter on a file diff leads to. */
type Location = { kind: "file"; path: RepoPath; line: number };

type Destination = Route | Location;

async function openFile({ path, line }: Location, cabaret: Cabaret): Promise<void> {
  const position = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(repositoryPath(cabaret)), path), {
    selection: new vscode.Range(position, position),
  });
}

async function renderRoute(cabaret: Cabaret, route: Route): Promise<Page> {
  if (route.kind === "home") {
    return cabaret.homeSectionPage(undefined, route.section);
  }
  const view = route.kind === "show" ? undefined : route.kind;
  const [tabs, page] = await Promise.all([
    cabaret.changeTabsPage(route.change, view),
    view === undefined ? cabaret.showPage(route.change) : cabaret.filesPage(route.change, view),
  ]);
  // Under the heading, which names the change the tabs are of.
  return inserted(page, 1, tabs);
}

/** `page` with `insert`'s lines put before its line `at`, and folds and cursor moved to match. */
function inserted(page: Page, at: number, insert: Page): Page {
  const shifted = (fold: Fold, by: number): Fold => ({ start: fold.start + by, end: fold.end + by });
  if (page.folds.some((fold) => fold.start < at && at <= fold.end)) {
    throw new Error(`line ${at} is inside a fold`);
  }
  return {
    lines: page.lines.toSpliced(at, 0, ...insert.lines),
    folds: [
      ...page.folds.map((fold) => (fold.start < at ? fold : shifted(fold, insert.lines.length))),
      ...insert.folds.map((fold) => shifted(fold, at)),
    ].toSorted((a, b) => a.start - b.start),
    cursor: page.cursor < at ? page.cursor : page.cursor + insert.lines.length,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Worktree root") && message.includes("not a directory")
    ? `${message}. If this worktree was moved, run git -C <main-worktree> worktree repair <new-worktree-path>, then reopen Cabaret.`
    : message;
}

/**
 * Fetch from origin every `cabaret.vscode.fetchInterval` seconds, so that others' changes show up
 * without anyone asking; the refs they move refresh the pages.
 */
function fetchPeriodically(cabaret: Cabaret): vscode.Disposable {
  let stopped = false;
  let next: NodeJS.Timeout | undefined;
  // An unreachable origin fails every fetch, so report only the first of a run of failures.
  let failing = false;
  const fetch = async () => {
    const seconds = cabaret.fetchInterval();
    if (stopped || seconds === null || !cabaret.hasOrigin()) {
      return;
    }
    try {
      await cabaret.fetch();
      failing = false;
    } catch (error) {
      if (!failing) {
        void vscode.window.showErrorMessage(`Cabaret: fetching from origin failed: ${errorMessage(error)}`);
      }
      failing = true;
    }
    if (!stopped) {
      next = setTimeout(() => void reporting(fetch), seconds * 1000);
    }
  };
  void reporting(fetch);
  return new vscode.Disposable(() => {
    stopped = true;
    clearTimeout(next);
  });
}

/**
 * The sessions tail of a show page. A failure to list is reported in place of the list rather
 * than failing the page.
 */
async function sessionsPage(cabaret: Cabaret, change: ChangeId): Promise<Page> {
  try {
    return await cabaret.sessionsPage(change);
  } catch (error) {
    return {
      lines: [
        { segments: [] },
        { segments: [{ text: `Sessions: unavailable (${errorMessage(error)})`, tag: "Muted" }] },
      ],
      folds: [],
      cursor: 0,
    };
  }
}

function pageText(page: Page): string {
  return page.lines.map((line) => `${line.segments.map((segment) => segment.text).join("")}\n`).join("");
}

/** Every segment with its range in the rendered text. */
function* placed(page: Page): Generator<{ segment: Segment; range: vscode.Range }> {
  for (const [line, { segments }] of page.lines.entries()) {
    let start = 0;
    for (const segment of segments) {
      const end = start + segment.text.length;
      yield { segment, range: new vscode.Range(line, start, line, end) };
      start = end;
    }
  }
}

/** A targeted segment under the cursor, else the line's own target. */
function targetAt(page: Page, position: vscode.Position): Target | undefined {
  const line = page.lines[position.line];
  if (line === undefined) {
    return undefined;
  }
  let start = 0;
  for (const segment of line.segments) {
    const end = start + segment.text.length;
    if (segment.target !== undefined && position.character >= start && position.character < end) {
      return segment.target;
    }
    start = end;
  }
  return line.target;
}

const themed = (color: string): vscode.DecorationRenderOptions => ({ color: new vscode.ThemeColor(color) });

const STYLES: Record<Tag, vscode.DecorationRenderOptions> = {
  Heading: { fontWeight: "bold" },
  ChangeId: themed("textLink.foreground"),
  Revision: themed("textPreformat.foreground"),
  Label: themed("descriptionForeground"),
  Muted: themed("descriptionForeground"),
  Added: themed("gitDecoration.addedResourceForeground"),
  Deleted: themed("gitDecoration.deletedResourceForeground"),
  Modified: themed("gitDecoration.modifiedResourceForeground"),
  Renamed: themed("gitDecoration.renamedResourceForeground"),
  Copied: themed("gitDecoration.addedResourceForeground"),
};

const TAGS = Object.keys(STYLES) as Tag[];

/** Whether a tab shows one of our pages, file diffs or multi-file diffs. */
function isCabaretTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  return (input instanceof vscode.TabInputText && input.uri.scheme === SCHEME) || tabFileDiffs(tab).length > 0;
}

/** A side of a two-sided diff that is one of our blobs; a file diff of ours has at least one. */
function blobSide(input: vscode.TabInputTextDiff): vscode.Uri | undefined {
  return [input.modified, input.original].find((uri) => uri.scheme === BLOB_SCHEME);
}

/** The file diffs of ours a tab shows, with their sides: one in a diff, several in a multi-file diff. */
function tabFileDiffs(tab: vscode.Tab | undefined): { sides: vscode.TabInputTextDiff; diff: FileDiff }[] {
  const input = tab?.input;
  const inputs =
    input instanceof vscode.TabInputTextDiff
      ? [input]
      : input instanceof vscode.TabInputTextMultiDiff
        ? input.textDiffs
        : [];
  const blobs = inputs.map(blobSide);
  if (blobs.every((blob) => blob === undefined)) {
    return [];
  }
  return inputs.map((sides, index) => {
    const blob = blobs[index];
    if (blob === undefined) {
      throw new Error(`${sides.modified.toString()} is diffed alongside cabaret files but is not one`);
    }
    return { sides, diff: blobFileDiff(blob) };
  });
}

/**
 * `open` something, then close the cabaret tab it was opened from unless it was reopened: moving
 * around cabaret replaces the view, as in a browser, rather than piling up tabs.
 */
async function replacingActive(open: () => Promise<void>): Promise<void> {
  const from = vscode.window.tabGroups.activeTabGroup.activeTab;
  await open();
  if (from !== undefined && isCabaretTab(from) && from !== vscode.window.tabGroups.activeTabGroup.activeTab) {
    await vscode.window.tabGroups.close(from);
  }
}

/** `document`, in the page language if it is a page. */
async function inPageLanguage(document: vscode.TextDocument): Promise<vscode.TextDocument> {
  return document.uri.scheme !== SCHEME || document.languageId === PAGE_LANGUAGE
    ? document
    : vscode.languages.setTextDocumentLanguage(document, PAGE_LANGUAGE);
}

/** A page as its document shows it: rendered from the repository, and on a show page its sessions. */
type Served = { base: Page; tail: Page | undefined };

function whole({ base, tail }: Served): Page {
  return tail === undefined ? base : inserted(base, base.lines.length, tail);
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
}

/**
 * Serves `cabaret:` pages and paints their tags onto whichever editors show them.
 *
 * A page shows repository state that anything, in this window or not, may change at any time, so
 * rather than track which pages an action affects, every open page is re-rendered whenever the
 * state may have changed, and each page again as it comes into view.
 */
class PageProvider
  implements
    vscode.TextDocumentContentProvider,
    vscode.DocumentLinkProvider,
    vscode.FoldingRangeProvider,
    vscode.Disposable
{
  private readonly served = new Map<string, Served>();
  /** What to serve on the re-read that `changed` triggers. */
  private readonly pending = new Map<string, Served>();
  /** Each page's latest update, so that updates are served in the order they were started. */
  private readonly updates = new Map<string, Promise<void>>();
  /** The pages on screen, to tell those coming into view. */
  private onScreen = new Set<string>();
  /** Started with the first page rendered, as a window not on a repository has none to watch or fetch into. */
  private watchers = new Map<string, vscode.Disposable>();
  /**
   * Where the cursor last was on each page, to put it back on reopening: VS Code reopens a closed
   * page at the top, and Vim keeps its own cursor where it was, so the two disagree otherwise. A
   * page never visited starts at its own cursor.
   */
  private readonly selections = new Map<string, vscode.Selection>();
  /** The home section last shown, for the way back home to return to. */
  private homeSections = new Map<string, HomeSection>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly decorations = Object.fromEntries(
    TAGS.map((tag) => [tag, vscode.window.createTextEditorDecorationType(STYLES[tag])]),
  ) as Record<Tag, vscode.TextEditorDecorationType>;
  readonly onDidChange = this.changed.event;

  dispose(): void {
    this.changed.dispose();
    for (const watcher of this.watchers.values()) watcher.dispose();
    for (const decoration of Object.values(this.decorations)) {
      decoration.dispose();
    }
    this.served.clear();
    this.pending.clear();
    this.selections.clear();
  }

  /** Home at the section last shown, or before any was, the first with changes in it. */
  async home(cabaret: Cabaret): Promise<Route> {
    return { kind: "home", section: this.homeSections.get(cabaret.commonDir()) ?? (await cabaret.firstHomeSection()) };
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      this.pending.delete(key);
      this.served.set(key, pending);
      return pageText(whole(pending));
    }
    const served = { base: await this.render(uri), tail: this.served.get(key)?.tail };
    this.served.set(key, served);
    return pageText(whole(served));
  }

  /** The page `uri` now shows in the repository, without its sessions. */
  private async render(uri: vscode.Uri): Promise<Page> {
    const cabaret = await ensureRepository(uri);
    const route = parseRoute(uri);
    if (route.kind === "home") {
      this.homeSections.set(cabaret.commonDir(), route.section);
    }
    if (!this.watchers.has(cabaret.commonDir())) {
      this.watchers.set(
        cabaret.commonDir(),
        vscode.Disposable.from(this.watchRepository(cabaret), fetchPeriodically(cabaret)),
      );
    }
    return renderRoute(cabaret, route);
  }

  /**
   * Refresh open pages whenever the repository's refs move, which every change to what they show
   * does, from this window or elsewhere.
   */
  private watchRepository(cabaret: Cabaret): vscode.Disposable {
    // TODO-someday(joel): uncommitted edits move no ref, so the workspace page of a workspace no
    // window saves into waits to come into view.
    const refs = new vscode.RelativePattern(
      vscode.Uri.file(cabaret.commonDir()),
      "{HEAD,packed-refs,refs/**,worktrees/*/HEAD}",
    );
    const watcher = vscode.workspace.createFileSystemWatcher(refs);
    let settling: NodeJS.Timeout | undefined;
    // One transaction writes several refs, so refresh once they settle.
    const settle = () => {
      clearTimeout(settling);
      settling = setTimeout(() => void reporting(() => this.refreshOpen()), 100);
    };
    return vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(settle),
      watcher.onDidChange(settle),
      watcher.onDidDelete(settle),
      new vscode.Disposable(() => clearTimeout(settling)),
    );
  }

  /** `run` an update of the page at `uri` once its earlier updates are done. */
  private update(uri: vscode.Uri, run: () => Promise<void>): Promise<void> {
    const key = uri.toString();
    const updated = (this.updates.get(key) ?? Promise.resolve()).then(run, run);
    this.updates.set(key, updated);
    return updated;
  }

  /**
   * Show `next` in the open document of `uri`, rather than leave it stale until the re-read that
   * `changed` triggers lands.
   */
  private async serve(uri: vscode.Uri, next: Served): Promise<void> {
    const key = uri.toString();
    const document = openDocument(uri);
    if (document === undefined) {
      return;
    }
    // VS Code applies no edit, so raises no event, for a re-read of the same text.
    if (pageText(whole(next)) === document.getText()) {
      this.served.set(key, next);
      return;
    }
    const updated = new Promise<void>((resolve) => {
      const listeners = [
        vscode.workspace.onDidChangeTextDocument((event) => event.document === document && done()),
        vscode.workspace.onDidCloseTextDocument((closed) => closed === document && done()),
      ];
      function done(): void {
        for (const listener of listeners) {
          listener.dispose();
        }
        resolve();
      }
    });
    this.pending.set(key, next);
    this.changed.fire(uri);
    await updated;
    // Left by a close before the re-read, it would be served stale on the next open.
    this.pending.delete(key);
  }

  /**
   * Re-render `uri` from the repository if a document of it is open, its sessions to follow. A
   * failure is shown on the page, which no longer shows what is there, rather than reported:
   * nothing the user did just now failed.
   */
  private refresh(uri: vscode.Uri): Promise<void> {
    return this.update(uri, async () => {
      if (openDocument(uri) === undefined) {
        return;
      }
      const base = await this.render(uri).catch((error: unknown): Page => ({
        lines: [{ segments: [{ text: `unavailable (${errorMessage(error)})`, tag: "Muted" }] }],
        folds: [],
        cursor: 0,
      }));
      // The sessions listed before stay until relisted, rather than blink out.
      await this.serve(uri, { base, tail: this.served.get(uri.toString())?.tail });
      void this.listSessions(uri, base);
    });
  }

  /**
   * Listing sessions reads every transcript in the workspace, which is slow next to reading the
   * repository, so a show page is served without its sessions and gains them once listed, unless
   * re-rendered meanwhile.
   */
  private async listSessions(uri: vscode.Uri, base: Page): Promise<void> {
    const route = parseRoute(uri);
    if (route.kind !== "show") {
      return;
    }
    const tail = await sessionsPage(await ensureRepository(uri), route.change);
    await this.update(uri, async () => {
      if (this.served.get(uri.toString())?.base === base) {
        await this.serve(uri, { base, tail });
      }
    });
  }

  /** Re-render every open page, as the repository may have changed underneath them. */
  async refreshOpen(): Promise<void> {
    const pages = vscode.workspace.textDocuments.filter((document) => document.uri.scheme === SCHEME);
    await Promise.all(pages.map((document) => this.refresh(document.uri)));
  }

  /**
   * Re-render the pages coming into view among `editors`, which may have missed a change nothing
   * reports, such as an edit to another workspace's files.
   */
  async refreshArrivals(editors: readonly vscode.TextEditor[]): Promise<void> {
    const uris = editors.map((editor) => editor.document.uri);
    const arrivals = uris.filter((uri) => uri.scheme === SCHEME && !this.onScreen.has(uri.toString()));
    this.onScreen = new Set(uris.map((uri) => uri.toString()));
    await Promise.all(arrivals.map((uri) => this.refresh(uri)));
  }

  /**
   * Render the pages VS Code kept open through an extension host restart, which the new host has
   * no render of, so their targets, folds and colours work without reopening them.
   */
  async revive(): Promise<void> {
    this.onScreen = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));
    await this.refreshOpen();
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorate(editor);
    }
  }

  async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
    const page = this.page(document.uri);
    if (page === undefined) {
      return [];
    }
    const cabaret = await ensureRepository(document.uri);
    return [...placed(page)].flatMap(({ segment, range }) => {
      const route = targetRoute(segment.target);
      return route === undefined ? [] : [new vscode.DocumentLink(range, openPageUri(route, cabaret))];
    });
  }

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const page = this.page(document.uri);
    return (page?.folds ?? []).map((fold) => new vscode.FoldingRange(fold.start, fold.end));
  }

  page(uri: vscode.Uri): Page | undefined {
    const served = this.served.get(uri.toString());
    return served === undefined ? undefined : whole(served);
  }

  targetUnderCursor(editor: vscode.TextEditor): Target | undefined {
    const page = this.page(editor.document.uri);
    return page === undefined ? undefined : targetAt(page, editor.selection.active);
  }

  private startSelection(uri: vscode.Uri): vscode.Selection {
    const page = this.page(uri);
    if (page === undefined) {
      throw new Error(`${uri.toString()} is not rendered`);
    }
    const start = new vscode.Position(page.cursor, 0);
    return new vscode.Selection(start, start);
  }

  rememberSelection({ document, selection }: vscode.TextEditor): void {
    this.selections.set(document.uri.toString(), selection);
  }

  decorate(editor: vscode.TextEditor): void {
    const page = this.page(editor.document.uri);
    if (page === undefined) {
      return;
    }
    const tagged = [...placed(page)].flatMap(({ segment, range }) =>
      segment.tag === undefined ? [] : [{ tag: segment.tag, range }],
    );
    const ranges = Map.groupBy(tagged, ({ tag }) => tag);
    for (const tag of TAGS) {
      editor.setDecorations(
        this.decorations[tag],
        (ranges.get(tag) ?? []).map(({ range }) => range),
      );
    }
  }

  /** Re-render `route` from the repository and show it. */
  async open(route: Route, cabaret: Cabaret): Promise<void> {
    const uri = routeUri(route, cabaret);
    // A page not yet open is rendered as it opens, and its sessions listed as it comes into view.
    if (openDocument(uri) !== undefined) {
      await this.refresh(uri);
      this.onScreen.add(uri.toString());
    }
    await replacingActive(async () => {
      const document = await inPageLanguage(await vscode.workspace.openTextDocument(uri));
      const selection = this.selections.get(uri.toString()) ?? this.startSelection(uri);
      this.decorate(await vscode.window.showTextDocument(document, { preview: false, selection }));
    });
  }

  async show(destination: Destination, cabaret: Cabaret): Promise<void> {
    if (destination.kind === "file") {
      await openFile(destination, cabaret);
    } else {
      await this.open(destination, cabaret);
    }
  }
}

/**
 * One file of a change's `view`, as a two-sided diff shows it. The `tip` is the change's when the
 * diff was opened, so an action on the diff acts on what it shows even once the change moves on.
 */
type FileDiff = { view: DiffView; change: ChangeId; path: RepoPath; tip: RevisionId };

/** The files of a diff tab: one for a two-sided diff, several for a multi-file diff. */
type FilesDiff = Omit<FileDiff, "path"> & { paths: [RepoPath, ...RepoPath[]] };

/**
 * `cabaret-blob:/<blob path>?view=<view>&change=<id>&path=<path>&tip=<rev>[&revision=<rev>]`: the
 * text at `blobPath` in that revision, or empty with no revision, as one side of the file diff the
 * query names. The blob's own path differs from the diff's for the before side of a rename.
 */
function blobUri(diff: FileDiff, revision: RevisionId | undefined, blobPath: RepoPath, cabaret: Cabaret): vscode.Uri {
  const query = new URLSearchParams(diff);
  query.set("repository", repositoryPath(cabaret));
  if (revision !== undefined) {
    query.set("revision", revision);
  }
  return vscode.Uri.from({ scheme: BLOB_SCHEME, path: `/${blobPath}`, query: query.toString() });
}

/** The file diff a blob is a side of. */
function blobFileDiff(uri: vscode.Uri): FileDiff {
  const query = new URLSearchParams(uri.query);
  const [view, change, path, tip] = [query.get("view"), query.get("change"), query.get("path"), query.get("tip")];
  if (!isDiffView(view) || change === null || path === null || tip === null) {
    throw new Error(`${uri.toString()} names no file diff`);
  }
  return { view, change, path, tip };
}

class BlobProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const revision = new URLSearchParams(uri.query).get("revision");
    return revision === null ? "" : ((await (await ensureRepository(uri)).blob(revision, uri.path.slice(1))) ?? "");
  }
}

/** `cabaret-description:/<change>.md`: the change's description, as markdown. */
function descriptionUri(change: ChangeId, cabaret: Cabaret): vscode.Uri {
  return vscode.Uri.from({ scheme: DESCRIPTION_SCHEME, path: `/${change}.md`, query: repositoryQuery(cabaret) });
}

function descriptionChange(uri: vscode.Uri): ChangeId {
  const [, change] = /^\/(.+)\.md$/.exec(uri.path) ?? [];
  if (change === undefined) {
    throw new Error(`${uri.toString()} names no change`);
  }
  return change;
}

/**
 * Serves each change's description as a file to edit in place, with a save written to the
 * change's metadata. Descriptions never change underneath an editor as far as VS Code can tell,
 * so a save always goes through rather than raising a conflict.
 */
class DescriptionProvider implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: (await this.readFile(uri)).byteLength };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { description } = await (await ensureRepository(uri)).change(descriptionChange(uri));
    return Buffer.from(description ?? "");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const change = descriptionChange(uri);
    const text = Buffer.from(content).toString();
    await (await ensureRepository(uri)).setDescription(change, text.trim() === "" ? undefined : text);
  }

  readDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
}

/**
 * `files` of `change`'s `view` as two-sided diffs, every side read at one tip; files no longer in
 * the view are left out.
 */
async function fileDiffSides(
  cabaret: Cabaret,
  view: DiffView,
  change: ChangeId,
  files: ChangedFile[],
): Promise<{ before: vscode.Uri; after: vscode.Uri }[]> {
  const { tip, files: diffs } = await cabaret.viewDiff(
    change,
    view,
    files.map((file) => file.path),
  );
  return diffs.map(({ file, before, after }) => {
    const diff: FileDiff = { view, change, path: file.path, tip };
    const from = "from" in file ? file.from : file.path;
    return { before: blobUri(diff, before, from, cabaret), after: blobUri(diff, after, file.path, cabaret) };
  });
}

function diffTitle(subject: string, view: DiffView, change: ChangeId): string {
  const note = { diff: "", review: ", unreviewed", workspace: ", uncommitted" }[view];
  return `${subject} (${change}${note})`;
}

async function openFileDiff(cabaret: Cabaret, view: DiffView, change: ChangeId, file: ChangedFile): Promise<void> {
  const [sides] = await fileDiffSides(cabaret, view, change, [file]);
  if (sides === undefined) {
    throw new Error(`${file.path} is no longer in ${change}'s ${view}`);
  }
  const { before, after } = sides;
  // Pinned: a preview would take over the tab about to be closed.
  const options = { preview: false } satisfies vscode.TextDocumentShowOptions;
  await replacingActive(async () => {
    await vscode.commands.executeCommand("vscode.diff", before, after, diffTitle(file.path, view, change), options);
  });
}

/** Several files of a change's `view` in one multi-file diff; a lone file in a plain file diff. */
async function openFileDiffs(cabaret: Cabaret, view: DiffView, change: ChangeId, files: ChangedFile[]): Promise<void> {
  const [only, ...rest] = files;
  if (only === undefined) {
    throw new Error(`no files of ${change} to diff`);
  }
  if (rest.length === 0) {
    await openFileDiff(cabaret, view, change, only);
    return;
  }
  const sides = await fileDiffSides(cabaret, view, change, files);
  if (sides.length === 0) {
    throw new Error(`${words(files.map((file) => file.path))} is no longer in ${change}'s ${view}`);
  }
  const resources = sides.map(({ before, after }) => [after, before, after]);
  await replacingActive(async () => {
    await vscode.commands.executeCommand("vscode.changes", diffTitle(`${sides.length} files`, view, change), resources);
    // Pinned, as `vscode.changes` offers no option to open it so.
    await vscode.commands.executeCommand("workbench.action.keepEditor");
  });
}

/**
 * A link opening `route` through `cabaret.openPage`, so that a click replaces the page as Enter
 * does rather than opening beside it.
 */
function openPageUri(route: Route, cabaret: Cabaret): vscode.Uri {
  const query = JSON.stringify([routeUri(route, cabaret).toString()]);
  return vscode.Uri.from({ scheme: "command", path: "cabaret.openPage", query });
}

/** The page a target leads to, for those that lead to one. */
function targetRoute(target: Target | undefined): Route | undefined {
  switch (target?.kind) {
    case "Change":
      return { kind: "show", change: target.change };
    case "Files":
      return { kind: target.view, change: target.change };
    case "Home":
      return { kind: "home", section: target.section };
    default:
      return undefined;
  }
}

async function follow(cabaret: Cabaret, provider: PageProvider, target: Target): Promise<void> {
  switch (target.kind) {
    case "Change":
      await provider.open({ kind: "show", change: target.change }, cabaret);
      break;
    case "Files":
      await provider.open({ kind: target.view, change: target.change }, cabaret);
      break;
    case "Home":
      await provider.open({ kind: "home", section: target.section }, cabaret);
      break;
    case "Diff":
      await openFileDiffs(cabaret, target.view, target.change, target.files);
      break;
    case "Title":
      await editTitle(cabaret, provider, target.change);
      break;
    case "Description":
      await editDescription(target.change, cabaret);
      break;
    case "Session":
      await openSession(cabaret, target.change, target.session);
      break;
  }
}

async function editDescription(change: ChangeId, cabaret: Cabaret): Promise<void> {
  await vscode.window.showTextDocument(descriptionUri(change, cabaret));
}

/** Titles are one line, so they are edited in an input box rather than a buffer like descriptions. */
async function editTitle(cabaret: Cabaret, provider: PageProvider, change: ChangeId): Promise<void> {
  const { title } = await cabaret.change(change);
  const edited = (
    await vscode.window.showInputBox({
      title: `Cabaret: Edit Title of ${change}`,
      value: title,
      prompt: "Title of the change, blank for none",
      ignoreFocusOut: true,
    })
  )?.trim();
  if (edited === undefined || edited === (title ?? "")) {
    return;
  }
  await cabaret.setTitle(change, edited === "" ? undefined : edited);
  await provider.refreshOpen();
}

/** Terminals showing a resumed session, so a second Enter reveals the same one. */
const sessionTerminals = new Map<SessionId, vscode.Terminal>();

/**
 * Resume a Claude Code session in its own editor tab, running the CLI through the user's shell in
 * the workspace it was launched from.
 */
async function openSession(cabaret: Cabaret, change: ChangeId, session: SessionId): Promise<void> {
  const existing = sessionTerminals.get(session);
  if (existing !== undefined) {
    existing.show();
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: `claude ${session.slice(0, 8)}`,
    cwd: await cabaret.workspacePath(change),
    location: vscode.TerminalLocation.Editor,
  });
  sessionTerminals.set(session, terminal);
  terminal.sendText(`claude --resume ${session}`);
  terminal.show();
}

/** The change a page is about: on the home page the one under the cursor, else the page's own. */
function pageChange(provider: PageProvider, editor: vscode.TextEditor): ChangeId | undefined {
  const route = parseRoute(editor.document.uri);
  if (route.kind !== "home") {
    return route.change;
  }
  const target = provider.targetUnderCursor(editor);
  return target?.kind === "Change" ? target.change : undefined;
}

function activePage(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.scheme === SCHEME ? editor : undefined;
}

/** The files the active tab diffs, if it is a file diff or multi-file diff of ours. */
function activeFilesDiff(): FilesDiff | undefined {
  const [first, ...rest] = tabFileDiffs(vscode.window.tabGroups.activeTabGroup.activeTab).map(({ diff }) => diff);
  if (first === undefined) {
    return undefined;
  }
  const { view, change, tip } = first;
  const stray = rest.find((diff) => diff.view !== view || diff.change !== change || diff.tip !== tip);
  if (stray !== undefined) {
    throw new Error(`${stray.path} is not in the ${view} of ${change} at ${tip} like the rest of its tab`);
  }
  return { view, change, tip, paths: [first.path, ...rest.map((diff) => diff.path)] };
}

/** The file diff holding the cursor on the active tab: in a multi-file diff, the focused file's. */
function focusedFileDiff(): FileDiff | undefined {
  const diffs = tabFileDiffs(vscode.window.tabGroups.activeTabGroup.activeTab);
  const cursor = vscode.window.activeTextEditor?.document.uri.toString();
  const focused =
    diffs.length === 1
      ? diffs[0]
      : diffs.find(({ sides }) => [sides.original, sides.modified].some((uri) => uri.toString() === cursor));
  return focused?.diff;
}

type PageKind = Route["kind"] | "file";

/** The pages whose `!` keys act on their change; the workspace page's commit its files instead. */
const ACTS_ON_CHANGE: PageKind[] = ["home", "show", "diff", "review"];

/**
 * Expose the active page's kind as the `cabaret.page` context, on a file diff its view as
 * `cabaret.view`, and whether its `!` keys act on its change as `cabaret.actsOnChange`, so
 * keybindings can scope to pages.
 */
function updatePageContext(): void {
  const filesDiff = activeFilesDiff();
  const editor = activePage();
  const kind: PageKind | undefined =
    filesDiff !== undefined ? "file" : editor === undefined ? undefined : parseRoute(editor.document.uri).kind;
  vscode.commands.executeCommand("setContext", "cabaret.page", kind);
  vscode.commands.executeCommand("setContext", "cabaret.view", filesDiff?.view);
  const actsOnChange = kind !== undefined && ACTS_ON_CHANGE.includes(kind);
  vscode.commands.executeCommand("setContext", "cabaret.actsOnChange", actsOnChange);
}

/** The scope enclosing a page: a change's diffs sit in its show page, which sits in `home`. */
async function enclosing(route: Route, home: () => Promise<Route>): Promise<Route | undefined> {
  switch (route.kind) {
    case "home":
      return undefined;
    case "show":
      return home();
    case "diff":
    case "review":
    case "workspace":
      return { kind: "show", change: route.change };
  }
}

/**
 * The change the active file diff or page is about, or a workspace file's checked-out one; where
 * nothing on screen implies a change, the checkout chosen by the command resolver.
 */
async function activeChange(cabaret: Cabaret, provider: PageProvider): Promise<ChangeId | undefined> {
  return (await impliedChange(cabaret, provider)) ?? cabaret.currentChange();
}

/** A new change with no parent in view most often wants to start off trunk, so skip the picker. */
async function parentForNewChange(cabaret: Cabaret, provider: PageProvider): Promise<ChangeId> {
  return (await impliedChange(cabaret, provider)) ?? cabaret.trunk();
}

async function impliedChange(cabaret: Cabaret, provider: PageProvider): Promise<ChangeId | undefined> {
  const filesDiff = activeFilesDiff();
  if (filesDiff !== undefined) {
    return filesDiff.change;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return undefined;
  }
  if (editor.document.uri.scheme === SCHEME) {
    return pageChange(provider, editor);
  }
  if (editor.document.uri.scheme === DESCRIPTION_SCHEME) {
    return descriptionChange(editor.document.uri);
  }
  if (editor.document.uri.scheme !== "file") {
    return undefined;
  }
  let fileRepository: Cabaret;
  try {
    fileRepository = new Cabaret(dirname(editor.document.uri.fsPath));
  } catch {
    return undefined;
  }
  if (fileRepository.commonDir() !== cabaret.commonDir()) {
    return undefined;
  }
  return fileRepository.currentChange();
}

/** `run` on the change the active page is about, or one the user picks; nothing if they decline. */
function onChange(
  name: string,
  provider: PageProvider,
  run: (cabaret: Cabaret, change: ChangeId) => Promise<void>,
): vscode.Disposable {
  return command(name, async (cabaret) => {
    const change = await activeChange(cabaret, provider);
    if (change !== undefined) {
      await run(cabaret, change);
    }
  });
}

/** The row leading to `change`, if the page draws it. */
function rowOf(page: Page, change: ChangeId): number | undefined {
  const row = page.lines.findIndex((line) => line.target?.kind === "Change" && line.target.change === change);
  return row === -1 ? undefined : row;
}

type Direction = "up" | "down";

/**
 * `d`/`r`: the change's diff or review page, or from a file diff of the other committed view,
 * the same files seen in `view`; files with nothing left in `view` are dropped, and with none
 * left it falls back to the page.
 */
async function switchView(cabaret: Cabaret, provider: PageProvider, view: CommittedView): Promise<void> {
  const filesDiff = activeFilesDiff();
  if (filesDiff !== undefined && filesDiff.view !== "workspace") {
    const { change, paths } = filesDiff;
    const files = (await cabaret.viewFiles(change, view)).filter((file) => paths.includes(file.path));
    const missing = paths.filter((path) => !files.some((file) => file.path === path));
    if (missing.length > 0) {
      vscode.window.setStatusBarMessage(
        `Cabaret: ${words(missing)} has nothing ${view === "review" ? "unreviewed" : "changed"} in ${change}`,
        3000,
      );
    }
    await (files.length === 0
      ? provider.open({ kind: view, change }, cabaret)
      : openFileDiffs(cabaret, view, change, files));
    return;
  }
  const change = await activeChange(cabaret, provider);
  if (change !== undefined) {
    await provider.open({ kind: view, change }, cabaret);
  }
}

/** On a file diff, `^`/`$` go to the file above or below its files in the same view of the change. */
async function stepFile(cabaret: Cabaret, { view, change, paths }: FilesDiff, direction: Direction): Promise<void> {
  const files = await cabaret.viewFiles(change, view);
  const shown = (file: ChangedFile) => paths.includes(file.path);
  const index = direction === "up" ? files.findIndex(shown) : files.findLastIndex(shown);
  const edge = files[index];
  if (edge === undefined) {
    throw new Error(`${words(paths)} is no longer in ${change}'s diff`);
  }
  const file = files[direction === "up" ? index - 1 : index + 1];
  if (file === undefined) {
    const end = direction === "up" ? "first" : "last";
    vscode.window.setStatusBarMessage(`Cabaret: ${edge.path} is the ${end} file in ${change}`, 3000);
    return;
  }
  await openFileDiff(cabaret, view, change, file);
}

/**
 * Step from the change the active page is about to one of its parents or children: on the home
 * page by moving the cursor onto its row, or opening it when it is not drawn there; on a change's
 * page by opening the same kind of page for it. On a file diff, step between the change's files.
 */
async function step(cabaret: Cabaret, provider: PageProvider, direction: Direction): Promise<void> {
  const filesDiff = activeFilesDiff();
  if (filesDiff !== undefined) {
    await stepFile(cabaret, filesDiff, direction);
    return;
  }
  const editor = activePage();
  if (editor === undefined) {
    return;
  }
  const from = pageChange(provider, editor);
  if (from === undefined) {
    return;
  }
  const relation = direction === "up" ? "parents" : "children";
  const candidates = [...(direction === "up" ? (await cabaret.change(from)).parents : await cabaret.children(from))];
  if (candidates.length === 0) {
    vscode.window.setStatusBarMessage(`Cabaret: ${from} has no ${relation}`, 3000);
    return;
  }
  const to =
    candidates.length === 1
      ? candidates[0]
      : (
          await vscode.window.showQuickPick(await changeItems(cabaret, candidates), {
            title: `Cabaret: ${relation} of ${from}`,
          })
        )?.change;
  if (to === undefined) {
    return;
  }
  const route = parseRoute(editor.document.uri);
  if (route.kind !== "home") {
    await provider.open({ ...route, change: to }, cabaret);
    return;
  }
  const page = provider.page(editor.document.uri);
  const row = page === undefined ? undefined : rowOf(page, to);
  if (row === undefined) {
    await provider.open({ kind: "show", change: to }, cabaret);
    return;
  }
  const position = editor.document.validatePosition(new vscode.Position(row, editor.selection.active.character));
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
}

type ChangeItem = vscode.QuickPickItem & { change: ChangeId };

/** Picker entries named by title, with the id dimmed beside it to tell apart changes titled alike. */
async function changeItems(cabaret: Cabaret, changes: Iterable<ChangeId>, current?: ChangeId): Promise<ChangeItem[]> {
  const titles = await cabaret.titles();
  return [...changes].map((change) => {
    const title = titles[change];
    const notes = [title === undefined ? undefined : change, change === current ? "current" : undefined];
    return { label: title ?? change, description: notes.filter((note) => note !== undefined).join(" · "), change };
  });
}

async function pickChange(cabaret: Cabaret, title: string): Promise<ChangeId | undefined> {
  const items = await changeItems(cabaret, await cabaret.changes(), await cabaret.currentChange());
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: items.length === 0 ? "no changes" : undefined,
  });
  return picked?.change;
}

async function reporting(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    vscode.window.showErrorMessage(`Cabaret: ${errorMessage(error)}`);
  }
}

function command(name: string, run: (cabaret: Cabaret) => Promise<void>, checkoutFallback = false): vscode.Disposable {
  return vscode.commands.registerCommand(name, () =>
    reporting(async () => {
      const uri = activeRepositoryUri();
      let cabaret = uri === undefined ? undefined : await repositoryForUri(uri);
      if (cabaret === undefined && checkoutFallback && vscode.workspace.workspaceFolders?.length === 1) {
        try {
          cabaret = repositoryAt(vscode.workspace.workspaceFolders[0]!.uri.fsPath);
        } catch {
          /* container */
        }
      }
      cabaret ??= await pickWorkspace();
      if (cabaret !== undefined) await run(cabaret);
    }),
  );
}

/**
 * What a window opened on another workspace should show first, in global state since a new
 * window starts its own extension host. Dated, as the window never starts when the folder is
 * already open elsewhere, and a handoff must not surprise a later start.
 */
type Handoff = { destination: Destination; at: number };

const HANDOFF_TTL = 60_000;

const handoffKey = (dir: string): string => `handoff:${dir}`;

/** Open the workspace at `dir` in a new window, showing `destination` there. */
async function openWorkspace(
  context: vscode.ExtensionContext,
  dir: string,
  destination: Destination | undefined,
): Promise<void> {
  if (destination !== undefined) {
    const handoff: Handoff = { destination, at: Date.now() };
    await context.globalState.update(handoffKey(dir), handoff);
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: true });
}

/** On startup, show what a window elsewhere left for this window's workspace. */
async function takeHandoff(context: vscode.ExtensionContext, provider: PageProvider): Promise<void> {
  if (vscode.workspace.workspaceFolders === undefined) {
    return;
  }
  const dir = vscode.workspace.workspaceFolders[0]!.uri.fsPath;
  const handoff = context.globalState.get<Handoff>(handoffKey(dir));
  if (handoff === undefined) {
    return;
  }
  await context.globalState.update(handoffKey(dir), undefined);
  if (Date.now() - handoff.at < HANDOFF_TTL) {
    await provider.show(handoff.destination, repositoryAt(dir));
  }
}

/** The file at the cursor on the active file diff. */
function cursorLocation({ path }: FileDiff): Location {
  // Read off whichever side holds the cursor, so only approximate on the before side.
  const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
  return { kind: "file", path, line };
}

/** The file at the cursor on the active file diff, else the active page. */
function activeDestination(): Destination | undefined {
  const fileDiff = focusedFileDiff();
  if (fileDiff !== undefined) {
    return cursorLocation(fileDiff);
  }
  const editor = activePage();
  return editor === undefined ? undefined : parseRoute(editor.document.uri);
}

async function gotoWorkspace(
  context: vscode.ExtensionContext,
  cabaret: Cabaret,
  provider: PageProvider,
): Promise<void> {
  const change = await activeChange(cabaret, provider);
  if (change === undefined) {
    return;
  }
  const destination = activeDestination();
  const workspace = await workspaceFor(cabaret, change);
  if (workspace === undefined) {
    return;
  }
  if (workspace.kind === "Here") {
    if (destination !== undefined) {
      await provider.show(destination, cabaret);
    }
  } else {
    await openWorkspace(context, workspace.path, destination);
  }
}

/** Find a change's workspace, offering to create one or check out here if it has none. */
async function workspaceFor(
  cabaret: Cabaret,
  change: ChangeId,
): Promise<{ kind: "Here" } | { kind: "Elsewhere"; path: string } | undefined> {
  const placement = await cabaret.placement(change);
  switch (placement.kind) {
    case "Here":
      return { kind: "Here" };
    case "Elsewhere":
      return { kind: "Elsewhere", path: await cabaret.workspacePath(change) };
    case "Nowhere": {
      const offer = placement.dedicated ? "Create Workspace" : "Check Out Here";
      const detail = placement.dedicated
        ? `Create a workspace for ${change} and open it in a new window.`
        : `Check ${change} out in this workspace.`;
      const message = `Cabaret: ${change} is not checked out in any workspace`;
      if ((await vscode.window.showInformationMessage(message, { modal: true, detail }, offer)) === undefined) {
        return undefined;
      }
      if (placement.dedicated) {
        return { kind: "Elsewhere", path: await cabaret.workspaceAdd(change) };
      }
      const switching = (allow: SafeguardKind[]) => cabaret.workspaceSwitch(change, allow);
      if ((await despite(`Check ${change} out here`, "Check Out Anyway", [], switching)) === undefined) {
        return undefined;
      }
      return { kind: "Here" };
    }
  }
}

/** Enter on a file diff opens the file at the cursor's line in the change's workspace. */
async function enterFile(context: vscode.ExtensionContext, cabaret: Cabaret, fileDiff: FileDiff): Promise<void> {
  const location = cursorLocation(fileDiff);
  const workspace = await workspaceFor(cabaret, fileDiff.change);
  if (workspace === undefined) {
    return;
  }
  if (workspace.kind === "Here") {
    await openFile(location, cabaret);
  } else {
    await openWorkspace(context, workspace.path, location);
  }
}

/**
 * `! m` on a file diff: record its files as reviewed up to the tip the diff shows, then move on to
 * the next file in the view as `$` would; after the last, wrap to the view's first file still
 * unreviewed, or back to the view's page once none is. A workspace diff shows nothing committed
 * to review.
 */
async function markFiles(
  cabaret: Cabaret,
  provider: PageProvider,
  { view, change, paths, tip }: FilesDiff,
): Promise<void> {
  if (view === "workspace") {
    throw new Error(`${words(paths)} is uncommitted in ${change}; commit it to review it`);
  }
  // Found before marking, which takes the files out of the review view.
  const files = await cabaret.viewFiles(change, view);
  const index = files.findLastIndex((file) => paths.includes(file.path));
  if (index === -1) {
    throw new Error(`${words(paths)} is no longer in ${change}'s diff`);
  }
  await cabaret.mark(change, paths, tip);
  vscode.window.showInformationMessage(
    `Cabaret: marked ${words(paths)} of ${change} reviewed up to ${tip.slice(0, 8)}`,
  );
  const unreviewed = new Set((await cabaret.viewFiles(change, "review")).map((file) => file.path));
  const next = files[index + 1] ?? files.find((file) => unreviewed.has(file.path));
  await (next === undefined
    ? provider.open({ kind: view, change }, cabaret)
    : openFileDiff(cabaret, view, change, next));
}

/** `! m` on a diff or review page: record the selected files as reviewed up to the change's tip. */
async function markSelected(cabaret: Cabaret, provider: PageProvider, editor: vscode.TextEditor): Promise<void> {
  const route = parseRoute(editor.document.uri);
  if (route.kind !== "diff" && route.kind !== "review") {
    throw new Error(`the ${route.kind} page lists nothing to review`);
  }
  const page = provider.page(editor.document.uri);
  const files = page === undefined ? [] : selectedFiles(page, editor.selections, route.kind);
  if (files.length === 0) {
    throw new Error("no file is selected");
  }
  const paths = files.map((file) => file.path);
  await cabaret.mark(route.change, paths);
  vscode.window.showInformationMessage(`Cabaret: marked ${words(paths)} of ${route.change} reviewed`);
  await provider.refreshOpen();
}

/** Enter over a selection on a view's page: the selected files side by side in a multi-file diff. */
async function diffSelected(cabaret: Cabaret, provider: PageProvider, editor: vscode.TextEditor): Promise<void> {
  const route = parseRoute(editor.document.uri);
  if (route.kind !== "diff" && route.kind !== "review" && route.kind !== "workspace") {
    throw new Error(`the ${route.kind} page lists no files to diff`);
  }
  const page = provider.page(editor.document.uri);
  const files = page === undefined ? [] : selectedFiles(page, editor.selections, route.kind);
  if (files.length === 0) {
    throw new Error("no file is selected");
  }
  await openFileDiffs(cabaret, route.kind, route.change, files);
}

/**
 * The changes on the rows selected on the active home page, top down, skipping those shown as
 * context and refusing none; undefined when there is no selection there.
 */
function selectedChanges(provider: PageProvider): ChangeId[] | undefined {
  const editor = activePage();
  if (
    editor === undefined ||
    parseRoute(editor.document.uri).kind !== "home" ||
    editor.selections.every((selection) => selection.isEmpty)
  ) {
    return undefined;
  }
  const page = provider.page(editor.document.uri);
  if (page === undefined) {
    throw new Error(`${editor.document.uri.toString()} is not rendered`);
  }
  const targets = selectedRows(editor.selections).flatMap((row) => {
    const target = page.lines[row]?.target;
    return target?.kind === "Change" ? [target] : [];
  });
  if (targets.length === 0) {
    throw new Error("no change is selected");
  }
  const changes = targets.filter(({ context }) => !context).map(({ change }) => change);
  if (changes.length === 0) {
    throw new Error("only changes shown as context are selected");
  }
  return [...new Set(changes)];
}

/** What a step of a sequence did, and whether the sequence may go on past it. */
type Step = { report: string; complete: boolean };

/**
 * The step to run on each change of a sequence, the order to go through them when not top down,
 * and what to do once every step completed.
 */
type Plan = { order?: ChangeId[]; step: (change: ChangeId) => Promise<Step>; finish?: () => Promise<void> };

/**
 * Like `action`, but over a selection on the home page `run` goes through the selected changes
 * top down, stopping at the first it cannot complete.
 */
function sequencedAction(
  name: string,
  provider: PageProvider,
  run: (cabaret: Cabaret, change: ChangeId) => Promise<Step>,
): vscode.Disposable {
  return plannedSequence(name, provider, async (cabaret) => ({ step: (change) => run(cabaret, change) }));
}

/**
 * Like `sequencedAction`, but `plan` first sees every change the sequence will go through, and
 * gives the plan to run over them, or nothing when the user backed out.
 */
function plannedSequence(
  name: string,
  provider: PageProvider,
  plan: (cabaret: Cabaret, changes: ChangeId[]) => Promise<Plan | undefined>,
): vscode.Disposable {
  return command(name, async (cabaret) => {
    const selected = selectedChanges(provider);
    const active = selected === undefined ? await activeChange(cabaret, provider) : undefined;
    const changes = selected ?? (active === undefined ? [] : [active]);
    if (changes.length === 0) {
      return;
    }
    const planned = await plan(cabaret, changes);
    if (planned === undefined) {
      return;
    }
    const order = planned.order ?? changes;
    const reports: string[] = [];
    try {
      for (const [index, change] of order.entries()) {
        const { report, complete } = await planned.step(change);
        reports.push(report);
        const skipped = order.slice(index + 1);
        if (!complete) {
          if (skipped.length > 0) {
            reports.push(`stopped before ${words(skipped)}`);
          }
          return;
        }
      }
      await planned.finish?.();
    } finally {
      // A failure partway through still leaves the earlier steps done, so report and show them.
      if (reports.length > 0) {
        vscode.window.showInformationMessage(`Cabaret: ${reports.join("; ")}`);
        await provider.refreshOpen();
      }
    }
  });
}

/** What an action did, and the page its result is on when not the active one. */
type Outcome = string | { report: string; show: Route };

/**
 * `!` then a key: `run` acts on the change the active page is about, found by `subject`, and says
 * what it did, or nothing when the user backed out; the page is then re-rendered to show the
 * result, or the page `run` names is opened instead.
 */
function action(
  name: string,
  provider: PageProvider,
  run: (cabaret: Cabaret, change: ChangeId) => Promise<Outcome | undefined>,
  subject: (cabaret: Cabaret, provider: PageProvider) => Promise<ChangeId | undefined> = activeChange,
): vscode.Disposable {
  return command(name, async (cabaret) => {
    const change = await subject(cabaret, provider);
    if (change === undefined) {
      return;
    }
    const outcome = await run(cabaret, change);
    if (outcome === undefined) {
      return;
    }
    const { report, show } = typeof outcome === "string" ? { report: outcome, show: undefined } : outcome;
    vscode.window.showInformationMessage(`Cabaret: ${report}`);
    await (show === undefined ? provider.refreshOpen() : provider.open(show, cabaret));
  });
}

const words = (ids: Iterable<string>): string => [...ids].join(", ");

/** The safeguards that would refuse each of `changes`, leaving out those none would. */
async function safeguarded(
  changes: ChangeId[],
  safeguards: (change: ChangeId) => Promise<Safeguard[]>,
): Promise<Map<ChangeId, Safeguard[]>> {
  const found = new Map<ChangeId, Safeguard[]>();
  for (const change of changes) {
    const those = await safeguards(change);
    if (those.length > 0) {
      found.set(change, those);
    }
  }
  return found;
}

function describeSafeguards(safeguards: Map<ChangeId, Safeguard[]>): string {
  return [...safeguards].flatMap(([change, those]) => those.map(({ message }) => `${change}: ${message}`)).join("\n");
}

/** Whether the user will `action` despite `safeguards`, asking only when there are any. */
async function accept(action: string, proceed: string, safeguards: Map<ChangeId, Safeguard[]>): Promise<boolean> {
  if (safeguards.size === 0) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    `${action} anyway?`,
    { modal: true, detail: describeSafeguards(safeguards) },
    proceed,
  );
  return choice === proceed;
}

/** The kinds the user accepted for `change` when shown `safeguards`. */
function allowed(safeguards: Map<ChangeId, Safeguard[]>, change: ChangeId): SafeguardKind[] {
  return (safeguards.get(change) ?? []).map(({ kind }) => kind);
}

type Refused = { outcome: "Refused"; safeguards: Safeguard[] };

/**
 * `attempt` allowing `allow`, and whenever safeguards not yet allowed refuse it, asking whether to
 * `action` anyway and retrying with those allowed too; undefined once the user declines.
 */
async function despite<Done extends { outcome: "Done" }>(
  action: string,
  proceed: string,
  allow: SafeguardKind[],
  attempt: (allow: SafeguardKind[]) => Promise<Done | Refused>,
): Promise<Done | undefined> {
  for (;;) {
    const result = await attempt(allow);
    if (result.outcome === "Done") {
      return result;
    }
    const again = result.safeguards.filter(({ kind }) => allow.includes(kind));
    if (again.length > 0) {
      throw new Error(
        `cannot ${action}: refused by safeguards already allowed: ${words(again.map(({ kind }) => kind))}`,
      );
    }
    const choice = await vscode.window.showWarningMessage(
      `${action} anyway?`,
      { modal: true, detail: result.safeguards.map(({ message }) => message).join("\n") },
      proceed,
    );
    if (choice !== proceed) {
      return undefined;
    }
    allow = [...allow, ...result.safeguards.map(({ kind }) => kind)];
  }
}

/** Rebase, once the user accepts any safeguards that would refuse it. */
async function planRebase(cabaret: Cabaret, changes: ChangeId[]): Promise<Plan | undefined> {
  const safeguards = await safeguarded(changes, (change) => cabaret.rebaseSafeguards(change, undefined));
  if (!(await accept(`Rebase ${words(safeguards.keys())}`, "Rebase Anyway", safeguards))) {
    return undefined;
  }
  return { step: (change) => rebase(cabaret, change, allowed(safeguards, change)) };
}

async function rebase(cabaret: Cabaret, change: ChangeId, allow: SafeguardKind[]): Promise<Step> {
  const rebasing = (allow: SafeguardKind[]) => cabaret.rebase(change, undefined, allow);
  const rebased = await despite(`Rebase ${change}`, "Rebase Anyway", allow, rebasing);
  if (rebased === undefined) {
    return { report: `did not rebase ${change}`, complete: false };
  }
  const { rebase } = rebased;
  const report = [
    rebase.merged.size === 0 ? `${change} is already up to date` : `rebased ${change} onto ${words(rebase.merged)}`,
  ];
  if (rebase.conflicts.size > 0) {
    report.push(`conflicts in ${words(rebase.conflicts)}`);
  }
  if (rebase.remaining.size > 0) {
    report.push(`resolve them and rebase again to continue onto ${words(rebase.remaining)}`);
  }
  return { report: report.join("; "), complete: rebase.conflicts.size === 0 && rebase.remaining.size === 0 };
}

function askChangeName(title: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({ title, prompt: "Name of the new change", ignoreFocusOut: true });
}

async function createChild(cabaret: Cabaret, parent: ChangeId): Promise<Outcome | undefined> {
  const name = await askChangeName(`Cabaret: Create Child of ${parent}`);
  if (name === undefined) {
    return undefined;
  }
  const child = await cabaret.create(name, parent);
  return { report: `created ${child} with parent ${parent}`, show: { kind: "show", change: child } };
}

async function createParent(cabaret: Cabaret, child: ChangeId): Promise<Outcome | undefined> {
  const name = await askChangeName(`Cabaret: Create Parent of ${child}`);
  if (name === undefined) {
    return undefined;
  }
  const parent = await cabaret.createParent(name, child);
  return { report: `created ${parent} as parent of ${child}`, show: { kind: "show", change: parent } };
}

async function addOwner(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const owner = await vscode.window.showInputBox({
    title: `Cabaret: Add Owner of ${change}`,
    prompt: "Email of the new owner",
    ignoreFocusOut: true,
  });
  if (owner === undefined) {
    return undefined;
  }
  await cabaret.addOwner(change, owner);
  return `added ${owner} as an owner of ${change}`;
}

async function removeOwner(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const { owners } = await cabaret.change(change);
  const owner = await vscode.window.showQuickPick([...owners], { title: `Cabaret: Remove Owner of ${change}` });
  if (owner === undefined) {
    return undefined;
  }
  const removing = (allow: SafeguardKind[]) => cabaret.removeOwner(change, owner, allow);
  if ((await despite(`Remove ${owner} as an owner of ${change}`, "Remove Anyway", [], removing)) === undefined) {
    return undefined;
  }
  return `removed ${owner} as an owner of ${change}`;
}

async function addParent(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const parent = await pickChange(cabaret, `Cabaret: Add Parent of ${change}`);
  if (parent === undefined) {
    return undefined;
  }
  const attempt = (allow: SafeguardKind[]) => cabaret.addParent(change, parent, allow);
  if ((await despite(`Add ${parent} as a parent of ${change}`, "Add Anyway", [], attempt)) === undefined) {
    return undefined;
  }
  return `added ${parent} as a parent of ${change}`;
}

async function removeParent(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const items = await changeItems(cabaret, (await cabaret.change(change)).declaredParents);
  const parent = (
    await vscode.window.showQuickPick(items, {
      title: `Cabaret: Remove Parent of ${change}`,
      placeHolder: items.length === 0 ? `${change} declares no parents` : undefined,
    })
  )?.change;
  if (parent === undefined) {
    return undefined;
  }
  const attempt = (allow: SafeguardKind[]) => cabaret.removeParent(change, parent, allow);
  if ((await despite(`Remove ${parent} as a parent of ${change}`, "Remove Anyway", [], attempt)) === undefined) {
    return undefined;
  }
  return `removed ${parent} as a parent of ${change}`;
}

/**
 * Start a headless Claude Code session on `change` with a prompt from the user, first offering to
 * create a workspace for a change checked out nowhere.
 */
async function startSession(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const prompt = await vscode.window.showInputBox({
    title: `Cabaret: Start Session on ${change}`,
    prompt: "What should the agent do?",
    ignoreFocusOut: true,
  });
  if (prompt === undefined || prompt === "") {
    return undefined;
  }
  if ((await cabaret.placement(change)).kind === "Nowhere") {
    const create = await vscode.window.showWarningMessage(
      `${change} is not checked out in any workspace. Create one for it?`,
      { modal: true },
      "Create Workspace",
    );
    if (create === undefined) {
      return undefined;
    }
    await cabaret.workspaceAdd(change);
  }
  const args = vscode.workspace
    .getConfiguration("cabaret")
    .get<string[]>("sessionArgs", ["--permission-mode", "auto", "--permission-prompts", "none"]);
  await cabaret.startSession(change, prompt, args);
  return `started a session on ${change}`;
}

/** The change among `changes` checked out in this window's workspace, if any. */
async function changeHere(cabaret: Cabaret, changes: Iterable<ChangeId>): Promise<ChangeId | undefined> {
  for (const change of changes) {
    if ((await cabaret.placement(change)).kind === "Here") {
      return change;
    }
  }
  return undefined;
}

/**
 * Once the user confirms, close every editor so unsaved files are dealt with before anything is
 * deleted.
 */
async function releaseHere(change: ChangeId): Promise<boolean> {
  const confirm = "Delete and Close Folder";
  const choice = await vscode.window.showWarningMessage(
    `Delete the workspace holding ${change}, which is open in this window?`,
    { modal: true, detail: "Every editor closes first, then this window's folder once the workspace is deleted." },
    confirm,
  );
  if (choice !== confirm) {
    return false;
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  if (vscode.workspace.textDocuments.some((document) => document.isDirty)) {
    throw new Error(`kept the workspace holding ${change}, as closing its unsaved files was cancelled`);
  }
  return true;
}

/**
 * Delete this window's workspace, which is left for last as the window's `Cabaret` is opened in it.
 * Closing the folder restarts the extension host, so nothing may follow it.
 */
async function deleteHereAndCloseFolder(cabaret: Cabaret, change: ChangeId, allow: SafeguardKind[]): Promise<void> {
  if (await deleteWorkspace(cabaret, change, allow)) {
    await vscode.commands.executeCommand("workbench.action.closeFolder");
  }
}

/**
 * Delete the workspace holding `change`, allowing `allow`, and asking again should other
 * safeguards refuse it; false when the user declines.
 */
async function deleteWorkspace(cabaret: Cabaret, change: ChangeId, allow: SafeguardKind[]): Promise<boolean> {
  const deleting = (allow: SafeguardKind[]) => cabaret.workspaceRemove(change, allow);
  return (await despite(`Delete the workspace holding ${change}`, "Delete Anyway", allow, deleting)) !== undefined;
}

/**
 * Land once the user confirms, since landing cannot be undone. Safeguards get a second
 * confirmation of their own, so a habitual Enter on the routine one cannot bypass them. Landing
 * archives a change that is not permanent, leaving its workspace nothing to do, so deleting those
 * workspaces is the default.
 */
async function planLand(cabaret: Cabaret, changes: ChangeId[]): Promise<Plan | undefined> {
  const doomed = new Map<ChangeId, WorkspaceId>();
  for (const change of changes) {
    const { permanent, workspace } = await cabaret.change(change);
    if (!permanent && workspace !== undefined) {
      doomed.set(change, workspace);
    }
  }
  const safeguards = await safeguarded(changes, (change) => cabaret.landSafeguards(change));
  const discarding = await safeguarded([...doomed.keys()], (change) => cabaret.workspaceRemoveSafeguards(change));
  const noun = doomed.size === 1 ? "Workspace" : "Workspaces";
  const landAndDelete = `Land and Delete ${noun}`;
  const landOnly = doomed.size === 0 ? "Land" : `Land and Keep ${noun}`;
  const irreversible =
    doomed.size === 0
      ? "This cannot be undone."
      : `This cannot be undone. These workspaces will have nothing left to do: ${words(doomed.values())}.`;
  const lost = discarding.size === 0 ? "" : `\n\nDeleting them would also discard:\n${describeSafeguards(discarding)}`;
  const choice = await vscode.window.showWarningMessage(
    `Land ${words(changes)}?`,
    { modal: true, detail: irreversible + lost },
    ...(doomed.size === 0 ? [landOnly] : [landAndDelete, landOnly]),
  );
  if (choice === undefined) {
    return undefined;
  }
  if (!(await accept(`Land ${words(safeguards.keys())}`, "Land Anyway", safeguards))) {
    return undefined;
  }
  const deleting = choice === landAndDelete;
  const here = deleting ? await changeHere(cabaret, doomed.keys()) : undefined;
  if (here !== undefined && !(await releaseHere(here))) {
    return undefined;
  }
  return {
    step: async (change) => {
      const landing = (allow: SafeguardKind[]) => cabaret.land(change, allow);
      const land = await despite(`Land ${change}`, "Land Anyway", allowed(safeguards, change), landing);
      if (land === undefined) {
        return { report: `did not land ${change}`, complete: false };
      }
      const landed = `landed ${change} into ${land.into}`;
      const workspace = doomed.get(change);
      if (!deleting || workspace === undefined || change === here) {
        return { report: landed, complete: true };
      }
      if (!(await deleteWorkspace(cabaret, change, allowed(discarding, change)))) {
        return { report: `${landed}; kept workspace ${workspace}`, complete: true };
      }
      return { report: `${landed}; deleted workspace ${workspace}`, complete: true };
    },
    finish: here === undefined ? undefined : () => deleteHereAndCloseFolder(cabaret, here, allowed(discarding, here)),
  };
}

async function planDeleteWorkspaces(cabaret: Cabaret, changes: ChangeId[]): Promise<Plan | undefined> {
  const discarding = await safeguarded(changes, (change) => cabaret.workspaceRemoveSafeguards(change));
  if (!(await accept(`Delete the workspaces holding ${words(discarding.keys())}`, "Delete Anyway", discarding))) {
    return undefined;
  }
  const here = await changeHere(cabaret, changes);
  if (here !== undefined && !(await releaseHere(here))) {
    return undefined;
  }
  return {
    step: async (change) => {
      if (change === here) {
        return { report: `left the workspace holding ${change}, open in this window, for last`, complete: true };
      }
      if (!(await deleteWorkspace(cabaret, change, allowed(discarding, change)))) {
        return { report: `did not delete the workspace holding ${change}`, complete: false };
      }
      return { report: `deleted the workspace holding ${change}`, complete: true };
    },
    finish: here === undefined ? undefined : () => deleteHereAndCloseFolder(cabaret, here, allowed(discarding, here)),
  };
}

async function toggleArchived(cabaret: Cabaret, change: ChangeId): Promise<Step> {
  const { archived } = await cabaret.change(change);
  const [verb, done] = archived ? ["Unarchive", "unarchived"] : ["Archive", "archived"];
  const toggling = (allow: SafeguardKind[]) =>
    archived ? cabaret.unarchive(change, allow) : cabaret.archive(change, allow);
  if ((await despite(`${verb} ${change}`, `${verb} Anyway`, [], toggling)) === undefined) {
    return { report: `did not ${verb.toLowerCase()} ${change}`, complete: false };
  }
  return { report: `${done} ${change}`, complete: true };
}

/**
 * Toggle whether each change is archived. Archiving leaves a change's workspace nothing to do, so
 * the user is first offered deleting those workspaces, as when landing. Children are drawn below
 * their parents, so unarchiving goes top down and archiving bottom up, sparing the safeguards
 * against archived parents and open children within the selection.
 */
async function planToggleArchived(cabaret: Cabaret, changes: ChangeId[]): Promise<Plan | undefined> {
  const unarchiving: ChangeId[] = [];
  const archiving: ChangeId[] = [];
  const doomed = new Map<ChangeId, WorkspaceId>();
  for (const change of changes) {
    const { archived, workspace } = await cabaret.change(change);
    (archived ? unarchiving : archiving).push(change);
    if (!archived && workspace !== undefined) {
      doomed.set(change, workspace);
    }
  }
  const discarding = await safeguarded([...doomed.keys()], (change) => cabaret.workspaceRemoveSafeguards(change));
  let deleting = false;
  if (doomed.size > 0) {
    const noun = doomed.size === 1 ? "Workspace" : "Workspaces";
    const archiveAndDelete = `Archive and Delete ${noun}`;
    const lost =
      discarding.size === 0 ? "" : `\n\nDeleting them would also discard:\n${describeSafeguards(discarding)}`;
    const choice = await vscode.window.showWarningMessage(
      `Archive ${words(doomed.keys())}?`,
      { modal: true, detail: `These workspaces will have nothing left to do: ${words(doomed.values())}.${lost}` },
      archiveAndDelete,
      `Archive and Keep ${noun}`,
    );
    if (choice === undefined) {
      return undefined;
    }
    deleting = choice === archiveAndDelete;
  }
  const here = deleting ? await changeHere(cabaret, doomed.keys()) : undefined;
  if (here !== undefined && !(await releaseHere(here))) {
    return undefined;
  }
  return {
    order: [...unarchiving, ...archiving.reverse()],
    step: async (change) => {
      // TODO-someday(joel): archive safeguards refuse per step, after the workspace dialog; checking
      // them up front, as landSafeguards does for land, would fold them into that one dialog.
      const toggled = await toggleArchived(cabaret, change);
      const workspace = doomed.get(change);
      if (!toggled.complete || !deleting || workspace === undefined || change === here) {
        return toggled;
      }
      if (!(await deleteWorkspace(cabaret, change, allowed(discarding, change)))) {
        return { report: `${toggled.report}; kept workspace ${workspace}`, complete: true };
      }
      return { report: `${toggled.report}; deleted workspace ${workspace}`, complete: true };
    },
    finish: here === undefined ? undefined : () => deleteHereAndCloseFolder(cabaret, here, allowed(discarding, here)),
  };
}

/** Commit `files` of `change`, all when empty, asking before committing despite safeguards. */
async function commit(cabaret: Cabaret, change: ChangeId, files: ChangedFile[]): Promise<boolean> {
  const committing = (allow: SafeguardKind[]) => cabaret.commit(change, files, allow);
  return (await despite(`Commit to ${change}`, "Commit Anyway", [], committing)) !== undefined;
}

async function commitAll(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  return (await commit(cabaret, change, [])) ? `committed all files to ${change}` : undefined;
}

/**
 * The rows the selections span, top down, or the cursor's row when nothing is selected. A
 * selection ending at the start of a line has not taken that line in.
 */
function selectedRows(selections: readonly vscode.Selection[]): number[] {
  const rows = new Set<number>();
  for (const { start, end } of selections) {
    const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
    for (let row = start.line; row <= last; row++) {
      rows.add(row);
    }
  }
  return [...rows].sort((a, b) => a - b);
}

/** The files of `view` on the selected rows. */
function selectedFiles(page: Page, selections: readonly vscode.Selection[], view: DiffView): ChangedFile[] {
  const files = selectedRows(selections).flatMap((row) => {
    const target = page.lines[row]?.target;
    return target?.kind === "Diff" && target.view === view ? target.files : [];
  });
  // A folder's row repeats the files on the rows under it.
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

/** The uncommitted files selected on the active page, refusing none. */
function selectedWorkspaceFiles(provider: PageProvider): ChangedFile[] {
  const editor = activePage();
  const page = editor === undefined ? undefined : provider.page(editor.document.uri);
  const files = editor === undefined || page === undefined ? [] : selectedFiles(page, editor.selections, "workspace");
  if (files.length === 0) {
    throw new Error("no file is selected");
  }
  return files;
}

async function commitSelected(cabaret: Cabaret, provider: PageProvider, change: ChangeId): Promise<string | undefined> {
  const files = selectedWorkspaceFiles(provider);
  if (!(await commit(cabaret, change, files))) {
    return undefined;
  }
  return `committed ${words(files.map((file) => file.path))} to ${change}`;
}

async function discardSelected(
  cabaret: Cabaret,
  provider: PageProvider,
  change: ChangeId,
): Promise<string | undefined> {
  const files = selectedWorkspaceFiles(provider);
  const paths = words(files.map((file) => file.path));
  const discard = await vscode.window.showWarningMessage(
    `Discard the uncommitted changes to ${paths} in ${change}?`,
    { modal: true, detail: "They are not recorded anywhere, so this cannot be undone." },
    "Discard",
  );
  if (discard === undefined) {
    return undefined;
  }
  await cabaret.discard(change, files);
  return `discarded ${paths} from ${change}`;
}

/** Escape walks out of a diff, then opens the worktree picker from an overview. */
async function stepOut(cabaret: Cabaret, provider: PageProvider): Promise<void> {
  const filesDiff = activeFilesDiff();
  if (filesDiff !== undefined) {
    await provider.open({ kind: filesDiff.view, change: filesDiff.change }, cabaret);
    return;
  }
  const editor = activePage();
  if (editor !== undefined && ["show", "home"].includes(parseRoute(editor.document.uri).kind)) {
    await showWorkspacePicker(provider);
    return;
  }
  const out =
    editor === undefined ? undefined : await enclosing(parseRoute(editor.document.uri), () => provider.home(cabaret));
  if (out !== undefined) {
    await provider.open(out, cabaret);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PageProvider();
  for (const document of vscode.workspace.textDocuments) {
    void inPageLanguage(document);
  }
  context.subscriptions.push(
    provider,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, provider),
    vscode.languages.registerFoldingRangeProvider({ scheme: SCHEME }, provider),
    vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, new BlobProvider()),
    vscode.workspace.registerFileSystemProvider(DESCRIPTION_SCHEME, new DescriptionProvider(), {
      isCaseSensitive: true,
    }),
    // Pages restored with the window or opened by a link skip `open`.
    vscode.workspace.onDidOpenTextDocument(inPageLanguage),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        provider.decorate(editor);
      }
      void reporting(() => provider.refreshArrivals(editors));
    }),
    // Coming back to the window, as from a terminal, is when changes made outside it show up.
    vscode.window.onDidChangeWindowState(({ focused }) => {
      if (focused) {
        void reporting(() => provider.refreshOpen());
      }
    }),
    // Saving a file changes what the workspace page shows, saving a description the show page.
    vscode.workspace.onDidSaveTextDocument(() => reporting(() => provider.refreshOpen())),
    vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
      if (textEditor.document.uri.scheme === SCHEME) {
        provider.rememberSelection(textEditor);
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [session, open] of sessionTerminals) {
        if (open === terminal) {
          sessionTerminals.delete(session);
        }
      }
    }),
    // A page that grew a tail needs its new lines painted too.
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document.uri.scheme === SCHEME) {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === document) {
            provider.decorate(editor);
          }
        }
      }
    }),
    // A switch updates the active editor and the tab model separately, so recompute on either.
    vscode.window.onDidChangeActiveTextEditor(updatePageContext),
    vscode.window.tabGroups.onDidChangeTabs(updatePageContext),
    vscode.commands.registerCommand("cabaret.openPage", (uri: string) =>
      reporting(async () =>
        provider.open(parseRoute(vscode.Uri.parse(uri)), await ensureRepository(vscode.Uri.parse(uri))),
      ),
    ),
    vscode.commands.registerCommand("cabaret.selectRepository", () => reporting(() => showWorkspacePicker(provider))),
    command(
      "cabaret.home",
      async (cabaret) => {
        await provider.open(await provider.home(cabaret), cabaret);
      },
      true,
    ),
    onChange("cabaret.showChange", provider, (cabaret, change) => provider.open({ kind: "show", change }, cabaret)),
    command("cabaret.diff", (cabaret) => switchView(cabaret, provider, "diff")),
    command("cabaret.review", (cabaret) => switchView(cabaret, provider, "review")),
    onChange("cabaret.workspaceDiff", provider, (cabaret, change) =>
      provider.open({ kind: "workspace", change }, cabaret),
    ),
    onChange("cabaret.editTitle", provider, (cabaret, change) => editTitle(cabaret, provider, change)),
    onChange("cabaret.editDescription", provider, (cabaret, change) => editDescription(change, cabaret)),
    // Enter: follow whatever the cursor is on, or diff the files selected on a view's page all at
    // once; on a file diff, into the file itself.
    command("cabaret.stepIn", async (cabaret) => {
      const fileDiff = focusedFileDiff();
      if (fileDiff !== undefined) {
        await enterFile(context, cabaret, fileDiff);
        return;
      }
      const editor = activePage();
      if (editor !== undefined && editor.selections.some((selection) => !selection.isEmpty)) {
        await diffSelected(cabaret, provider, editor);
        return;
      }
      const target = editor === undefined ? undefined : provider.targetUnderCursor(editor);
      if (target !== undefined) {
        await follow(cabaret, provider, target);
      }
    }),
    command("cabaret.stepOut", (cabaret) => stepOut(cabaret, provider)),
    command("cabaret.refresh", () => provider.refreshOpen()),
    // `! m`: mark reviewed what is on screen, a file diff or the files selected on a page. The
    // title bar button passes its diff, whose group a click leaves unfocused.
    vscode.commands.registerCommand("cabaret.mark", (clicked?: vscode.Uri) =>
      reporting(async () => {
        const uri = clicked ?? activeRepositoryUri();
        if (uri === undefined) return;
        const cabaret = await ensureRepository(uri);
        const active = tabFileDiffs(vscode.window.tabGroups.activeTabGroup.activeTab);
        if (clicked !== undefined && !active.some(({ sides }) => sides.modified.toString() === clicked.toString())) {
          throw new Error("focus the diff to mark it");
        }
        const filesDiff = activeFilesDiff();
        if (filesDiff !== undefined) {
          await markFiles(cabaret, provider, filesDiff);
          return;
        }
        const editor = activePage();
        if (editor !== undefined) {
          await markSelected(cabaret, provider, editor);
        }
      }),
    ),
    command("cabaret.stepUp", (cabaret) => step(cabaret, provider, "up")),
    command("cabaret.stepDown", (cabaret) => step(cabaret, provider, "down")),
    action("cabaret.createChild", provider, createChild, parentForNewChange),
    action("cabaret.createParent", provider, createParent),
    action("cabaret.addOwner", provider, addOwner),
    action("cabaret.removeOwner", provider, removeOwner),
    action("cabaret.addParent", provider, addParent),
    action("cabaret.removeParent", provider, removeParent),
    plannedSequence("cabaret.land", provider, planLand),
    plannedSequence("cabaret.rebase", provider, planRebase),
    plannedSequence("cabaret.toggleArchived", provider, planToggleArchived),
    action("cabaret.commitAll", provider, commitAll),
    action("cabaret.commitSelected", provider, (cabaret, change) => commitSelected(cabaret, provider, change)),
    action("cabaret.discardSelected", provider, (cabaret, change) => discardSelected(cabaret, provider, change)),
    action("cabaret.startSession", provider, startSession),
    sequencedAction("cabaret.createWorkspace", provider, async (cabaret, change) => ({
      report: `created a workspace for ${change} at ${await cabaret.workspaceAdd(change)}`,
      complete: true,
    })),
    plannedSequence("cabaret.deleteWorkspace", provider, planDeleteWorkspaces),
    command("cabaret.gotoWorkspace", (cabaret) => gotoWorkspace(context, cabaret, provider)),
  );
  updatePageContext();
  // Leaderkey scans `leaderkey.overrides.*` contributions when it activates, which can precede
  // this extension registering its own; a rescan picks the bindings up either way.
  if (vscode.extensions.getExtension("JimmyZJX.leaderkey") !== undefined) {
    void vscode.commands.executeCommand("leaderkey.refreshConfigs").then(undefined, () => undefined);
  }
  void reporting(() => provider.revive());
  void reporting(() => takeHandoff(context, provider));
}
