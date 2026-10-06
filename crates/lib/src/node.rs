// The napi boundary requires owned values for JS primitives.
// TODO-someday(joel): move js wrapper to a separate crate?
#![allow(clippy::needless_pass_by_value)]

use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::Arc,
};

use cabaret_agents::ClaudeCode;
use cabaret_config::FetchInterval;
use cabaret_page::{DiffView, HomeSection, Page};
use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Error, Identity, Pathspec, RepoPath, Result, RevisionId,
    ViewDiff, WorkspaceId,
    safeguard::{Allow, SafeguardKind},
};
use napi::bindgen_prelude::spawn_blocking;
use napi_derive::napi;
use nonempty_collections::{NEBTreeSet, NEVec};

use crate::cabaret::{Cabaret, Rebase};

/// How the workspace a [`Cabaret`] was opened in reaches a change's files.
#[derive(Debug, Clone, PartialEq, Eq)]
#[napi(discriminant = "kind", object_from_js = false)]
pub enum Placement {
    /// The change is checked out here.
    Here,
    /// The change is checked out in another workspace.
    Elsewhere { workspace: WorkspaceId },
    /// The change is checked out nowhere. This workspace could switch to it, unless it is
    /// dedicated to the change it holds; see [`Cabaret::workspace_is_dedicated`].
    Nowhere { dedicated: bool },
}

fn placement(cabaret: &Cabaret, change: &ChangeIdRef) -> Result<Placement> {
    let current = cabaret.workspace_current()?;
    Ok(match cabaret.workspace_holding(change)? {
        Some(workspace) if workspace == current => Placement::Here,
        Some(workspace) => Placement::Elsewhere { workspace },
        None => Placement::Nowhere { dedicated: cabaret.workspace_is_dedicated(current.to_ref())? },
    })
}

/// A [`cabaret_types::safeguard::Safeguard`] as a frontend presents it.
#[napi(object, object_from_js = false)]
pub struct Safeguard {
    pub kind: SafeguardKind,
    pub message: String,
}

fn presented(safeguards: impl IntoIterator<Item = cabaret_types::safeguard::Safeguard>) -> Vec<Safeguard> {
    let present = |safeguard: cabaret_types::safeguard::Safeguard| Safeguard {
        kind: safeguard.kind(),
        message: safeguard.to_string(),
    };
    safeguards.into_iter().map(present).collect()
}

/// Refusals as a value to present, other failures as the errors they are.
fn outcome<T>(result: Result<T>) -> Result<std::result::Result<T, NEVec<cabaret_types::safeguard::Safeguard>>> {
    match result {
        Ok(out) => Ok(Ok(out)),
        Err(Error::Refused(refused)) => Ok(Err(refused)),
        Err(error) => Err(error),
    }
}

/// What an action with nothing to report did.
#[napi(discriminant = "outcome", object_from_js = false)]
pub enum Attempt {
    Done,
    Refused { safeguards: Vec<Safeguard> },
}

impl From<std::result::Result<(), NEVec<cabaret_types::safeguard::Safeguard>>> for Attempt {
    fn from(attempt: std::result::Result<(), NEVec<cabaret_types::safeguard::Safeguard>>) -> Self {
        match attempt {
            Ok(()) => Self::Done,
            Err(refused) => Self::Refused { safeguards: presented(refused) },
        }
    }
}

/// What [`Cabaret::commit`] did.
#[napi(discriminant = "outcome", object_from_js = false)]
pub enum Committed {
    Done { revision: RevisionId },
    Refused { safeguards: Vec<Safeguard> },
}

/// What [`Cabaret::land`] did.
#[napi(discriminant = "outcome", object_from_js = false)]
pub enum Landed {
    Done { into: ChangeId },
    Refused { safeguards: Vec<Safeguard> },
}

/// What [`Cabaret::rebase`] did.
#[napi(discriminant = "outcome", object_from_js = false)]
pub enum Rebased {
    Done { rebase: Rebase },
    Refused { safeguards: Vec<Safeguard> },
}

fn path_string(path: PathBuf) -> Result<String> {
    path.into_os_string().into_string().map_err(|path| format!("{} is not UTF-8", PathBuf::from(path).display()).into())
}

/// A registered checkout and its branch, absent for detached HEAD.
#[napi(object)]
pub struct WorkspaceEntry {
    pub path: String,
    pub change: Option<ChangeId>,
}

#[napi(js_name = "Cabaret")]
pub struct CabaretJs {
    cabaret: Arc<Cabaret>,
}

impl CabaretJs {
    /// Runs `f` off the JS thread; gix work blocks on I/O and object decoding.
    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Cabaret) -> Result<T> + Send + 'static,
    ) -> napi::Result<T> {
        let cabaret = Arc::clone(&self.cabaret);
        let result = spawn_blocking(move || f(&cabaret)).await;
        Ok(result.map_err(|panic| napi::Error::from_reason(panic.to_string()))??)
    }
}

#[napi]
impl CabaretJs {
    #[napi(constructor)]
    pub fn new(dir: String) -> napi::Result<Self> { Ok(Self { cabaret: Arc::new(Cabaret::open(&dir)?) }) }

    #[napi]
    pub async fn changes(&self) -> napi::Result<Vec<ChangeId>> { self.blocking(Cabaret::changes).await }

    /// The title of every change that has one, by change id.
    #[napi]
    pub async fn titles(&self) -> napi::Result<HashMap<String, String>> {
        let titles = self.blocking(Cabaret::titles).await?;
        Ok(titles.into_iter().map(|(change, title)| (change.to_string(), title)).collect())
    }

    #[napi]
    pub async fn current_change(&self) -> napi::Result<ChangeId> { self.blocking(Cabaret::current_change).await }

    #[napi]
    pub async fn trunk(&self) -> napi::Result<ChangeId> { self.blocking(Cabaret::trunk).await }

    #[napi]
    pub async fn change(&self, id: ChangeId) -> napi::Result<ChangeSnapshot> {
        self.blocking(move |cabaret| cabaret.snapshot(&id)).await
    }

    #[napi]
    pub async fn children(&self, change: ChangeId) -> napi::Result<BTreeSet<ChangeId>> {
        self.blocking(move |cabaret| cabaret.children(&change)).await
    }

    #[napi]
    pub async fn show_page(&self, change: ChangeId) -> napi::Result<Page> {
        self.blocking(move |cabaret| cabaret.show_page(&change)).await
    }

    /// The files `change`'s `view` diffs; for review, those git's user.email has left to read.
    #[napi]
    pub async fn view_files(&self, change: ChangeId, view: DiffView) -> napi::Result<Vec<ChangedFile>> {
        self.blocking(move |cabaret| cabaret.view_files(&change, view, &[])).await
    }

    #[napi]
    pub async fn files_page(&self, change: ChangeId, view: DiffView) -> napi::Result<Page> {
        self.blocking(move |cabaret| cabaret.files_page(&change, view, &[])).await
    }

    #[napi]
    pub async fn change_tabs_page(&self, change: ChangeId, view: Option<DiffView>) -> napi::Result<Page> {
        self.blocking(move |cabaret| cabaret.change_tabs_page(&change, view)).await
    }

    /// Start a Claude Code session on `prompt` in the workspace holding `change`, returning once
    /// it is running. `args` go to the CLI ahead of the prompt.
    #[napi]
    pub async fn start_session(&self, change: ChangeId, prompt: String, args: Vec<String>) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.start_session(&change, &prompt, &args, &ClaudeCode::locate()?)).await
    }

    /// The Claude Code sessions that worked on `change`, as the tail of its show page.
    #[napi]
    pub async fn sessions_page(&self, change: ChangeId) -> napi::Result<Page> {
        self.blocking(move |cabaret| cabaret.sessions_page(&change, &ClaudeCode::locate()?)).await
    }

    /// `section` of the home page for `viewer`, defaulting to git's user.email.
    #[napi]
    pub async fn home_section_page(&self, viewer: Option<Identity>, section: HomeSection) -> napi::Result<Page> {
        self.blocking(move |cabaret| {
            let viewer = match viewer {
                Some(viewer) => viewer,
                None => cabaret.identity()?,
            };
            cabaret.home_section_page(&viewer, section)
        })
        .await
    }

    /// The first section of git's user.email's home page with changes in it.
    #[napi]
    pub async fn first_home_section(&self) -> napi::Result<HomeSection> {
        self.blocking(|cabaret| cabaret.first_home_section(&cabaret.identity()?)).await
    }

    /// The text of `path` at `revision_id`, or `None` when no file is there.
    // TODO-someday(joel): binary files
    #[napi]
    pub async fn blob(&self, revision_id: RevisionId, path: RepoPath) -> napi::Result<Option<String>> {
        self.blocking(move |cabaret| match cabaret.blob(revision_id, &path)? {
            Some(version) => Ok(Some(String::from_utf8(version.data.into())?)),
            None => Ok(None),
        })
        .await
    }

    /// The files `change`'s `view` diffs among `paths`, with the revisions holding both sides of
    /// each; for review, those git's user.email has left to read.
    #[napi]
    pub async fn view_diff(&self, change: ChangeId, view: DiffView, paths: Vec<RepoPath>) -> napi::Result<ViewDiff> {
        let pathspecs: Vec<Pathspec> = paths.iter().map(Pathspec::literal).collect();
        self.blocking(move |cabaret| cabaret.view_diff(&change, view, &pathspecs)).await
    }

    /// All checkouts of this repository, including those outside the opened folder.
    #[napi]
    pub async fn workspace_entries(&self) -> napi::Result<Vec<WorkspaceEntry>> {
        self.blocking(|cabaret| {
            cabaret.workspaces()?.into_iter().map(|(workspace, change)| {
                Ok(WorkspaceEntry { path: path_string(cabaret.workspace_path(workspace.to_ref())?)?, change })
            }).collect()
        }).await
    }

    /// Create a workspace holding `change` at the default location, returning its path.
    #[napi]
    pub async fn workspace_add(&self, change: ChangeId) -> napi::Result<String> {
        self.blocking(move |cabaret| path_string(cabaret.workspace_add(&change, None)?)).await
    }

    #[napi]
    pub async fn workspace_remove_safeguards(&self, change: ChangeId) -> napi::Result<Vec<Safeguard>> {
        let safeguards = self
            .blocking(move |cabaret| cabaret.workspace_remove_safeguards(cabaret.workspace_of(&change)?.to_ref()))
            .await?;
        Ok(presented(safeguards))
    }

    #[napi]
    pub async fn workspace_remove(&self, change: ChangeId, allow: Vec<SafeguardKind>) -> napi::Result<Attempt> {
        let attempt = self
            .blocking(move |cabaret| {
                let allow = Allow::from_iter(allow);
                outcome(cabaret.workspace_remove(cabaret.workspace_of(&change)?.to_ref(), &allow))
            })
            .await?;
        Ok(Attempt::from(attempt))
    }

    /// Seconds between background fetches from origin, or `None` for never.
    #[napi]
    pub fn fetch_interval(&self) -> napi::Result<Option<u32>> {
        Ok(match self.cabaret.config::<FetchInterval>()?.unwrap_or_default() {
            FetchInterval::Never => None,
            FetchInterval::Seconds(seconds) => Some(seconds.get()),
        })
    }

    #[napi]
    pub fn has_origin(&self) -> bool { self.cabaret.has_origin() }

    // TODO-someday(joel): show the editor which branches fetch kept apart from origin's
    #[napi]
    pub async fn fetch(&self) -> napi::Result<()> { self.blocking(|cabaret| cabaret.fetch().map(drop)).await }

    #[napi]
    pub fn common_dir(&self) -> napi::Result<String> {
        let path = std::fs::canonicalize(self.cabaret.common_dir())
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(path_string(path)?)
    }

    #[napi]
    pub async fn workspace_path(&self, change: ChangeId) -> napi::Result<String> {
        self.blocking(move |cabaret| path_string(cabaret.workspace_path(cabaret.workspace_of(&change)?.to_ref())?))
            .await
    }

    #[napi]
    pub async fn placement(&self, change: ChangeId) -> napi::Result<Placement> {
        self.blocking(move |cabaret| placement(cabaret, &change)).await
    }

    /// Check `change` out in the workspace this instance was opened in.
    #[napi]
    pub async fn workspace_switch(&self, change: ChangeId, allow: Vec<SafeguardKind>) -> napi::Result<Attempt> {
        let attempt = self
            .blocking(move |cabaret| {
                let allow = Allow::from_iter(allow);
                outcome(cabaret.workspace_switch(cabaret.workspace_current()?.to_ref(), &change, &allow))
            })
            .await?;
        Ok(Attempt::from(attempt))
    }

    /// Commit `files` of `change`'s workspace diff, or all of it when empty. Both sides of a
    /// rename go, so the move is committed rather than a copy.
    #[napi]
    pub async fn commit(
        &self,
        change: ChangeId,
        files: Vec<ChangedFile>,
        allow: Vec<SafeguardKind>,
    ) -> napi::Result<Committed> {
        let pathspecs: Vec<Pathspec> = files.iter().flat_map(ChangedFile::paths).map(Pathspec::literal).collect();
        let committed = self
            .blocking(move |cabaret| outcome(cabaret.commit(&change, &pathspecs, &Allow::from_iter(allow))))
            .await?;
        Ok(match committed {
            Ok(revision) => Committed::Done { revision },
            Err(refused) => Committed::Refused { safeguards: presented(refused) },
        })
    }

    /// Discard `files` of `change`'s workspace diff, or all of it when empty. Both sides of a
    /// rename go, so the moved file returns to where it was.
    #[napi]
    pub async fn discard(&self, change: ChangeId, files: Vec<ChangedFile>) -> napi::Result<()> {
        let pathspecs: Vec<Pathspec> = files.iter().flat_map(ChangedFile::paths).map(Pathspec::literal).collect();
        self.blocking(move |cabaret| cabaret.discard(&change, &pathspecs)).await
    }

    /// Create a change named `name` as a child of `parent`, owned by git's user.email, returning its id.
    #[napi]
    pub async fn create(&self, name: String, parent: ChangeId) -> napi::Result<ChangeId> {
        self.blocking(move |cabaret| cabaret.create(&name, &NEBTreeSet::new(parent), &cabaret.identity()?)).await
    }

    /// Create a change named `name` as a parent of `child`, owned by git's user.email, returning its id.
    #[napi]
    pub async fn create_parent(&self, name: String, child: ChangeId) -> napi::Result<ChangeId> {
        self.blocking(move |cabaret| cabaret.create_parent(&name, &child, &cabaret.identity()?)).await
    }

    #[napi]
    pub async fn add_owner(&self, change: ChangeId, owner: Identity) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.add_owner(&change, &owner)).await
    }

    #[napi]
    pub async fn remove_owner(
        &self,
        change: ChangeId,
        owner: Identity,
        allow: Vec<SafeguardKind>,
    ) -> napi::Result<Attempt> {
        let removed = self
            .blocking(move |cabaret| outcome(cabaret.remove_owner(&change, &owner, &Allow::from_iter(allow))))
            .await?;
        Ok(Attempt::from(removed))
    }

    #[napi]
    pub async fn add_parent(
        &self,
        change: ChangeId,
        parent: ChangeId,
        allow: Vec<SafeguardKind>,
    ) -> napi::Result<Attempt> {
        let attempt = self
            .blocking(move |cabaret| outcome(cabaret.add_parent(&change, &parent, &Allow::from_iter(allow))))
            .await?;
        Ok(Attempt::from(attempt))
    }

    #[napi]
    pub async fn remove_parent(
        &self,
        change: ChangeId,
        parent: ChangeId,
        allow: Vec<SafeguardKind>,
    ) -> napi::Result<Attempt> {
        let attempt = self
            .blocking(move |cabaret| outcome(cabaret.remove_parent(&change, &parent, &Allow::from_iter(allow))))
            .await?;
        Ok(Attempt::from(attempt))
    }

    /// Record that git's user.email has reviewed `files` of `change` up to `head`, defaulting to
    /// its tip.
    #[napi]
    pub async fn mark(&self, change: ChangeId, files: Vec<RepoPath>, head: Option<RevisionId>) -> napi::Result<()> {
        let pathspecs: Vec<Pathspec> = files.iter().map(Pathspec::literal).collect();
        self.blocking(move |cabaret| cabaret.mark(&change, &pathspecs, head).map(drop)).await
    }

    #[napi]
    pub async fn set_title(&self, change: ChangeId, title: Option<String>) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.set_title(&change, title)).await
    }

    #[napi]
    pub async fn set_description(&self, change: ChangeId, description: Option<String>) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.set_description(&change, description)).await
    }

    #[napi]
    pub async fn land_safeguards(&self, change: ChangeId) -> napi::Result<Vec<Safeguard>> {
        Ok(presented(self.blocking(move |cabaret| cabaret.land_safeguards(&change)).await?))
    }

    #[napi]
    pub async fn land(&self, change: ChangeId, allow: Vec<SafeguardKind>) -> napi::Result<Landed> {
        let landed = self.blocking(move |cabaret| outcome(cabaret.land(&change, &Allow::from_iter(allow)))).await?;
        Ok(match landed {
            Ok(into) => Landed::Done { into },
            Err(refused) => Landed::Refused { safeguards: presented(refused) },
        })
    }

    #[napi]
    pub async fn archive(&self, change: ChangeId, allow: Vec<SafeguardKind>) -> napi::Result<Attempt> {
        let attempt = self.blocking(move |cabaret| outcome(cabaret.archive(&change, &Allow::from_iter(allow)))).await?;
        Ok(Attempt::from(attempt))
    }

    #[napi]
    pub async fn unarchive(&self, change: ChangeId, allow: Vec<SafeguardKind>) -> napi::Result<Attempt> {
        let attempt =
            self.blocking(move |cabaret| outcome(cabaret.unarchive(&change, &Allow::from_iter(allow)))).await?;
        Ok(Attempt::from(attempt))
    }

    #[napi]
    pub async fn rebase_safeguards(&self, change: ChangeId, onto: Option<ChangeId>) -> napi::Result<Vec<Safeguard>> {
        Ok(presented(self.blocking(move |cabaret| cabaret.rebase_safeguards(&change, onto.as_deref())).await?))
    }

    #[napi]
    pub async fn rebase(
        &self,
        change: ChangeId,
        onto: Option<ChangeId>,
        allow: Vec<SafeguardKind>,
    ) -> napi::Result<Rebased> {
        let rebased = self
            .blocking(move |cabaret| outcome(cabaret.rebase(&change, onto.as_deref(), &Allow::from_iter(allow))))
            .await?;
        Ok(match rebased {
            Ok(rebase) => Rebased::Done { rebase },
            Err(refused) => Rebased::Refused { safeguards: presented(refused) },
        })
    }
}

/// Discover repositories in a checkout or a directory holding sibling worktrees, off the UI thread.
#[napi]
pub async fn discover_repositories(dir: String) -> napi::Result<Vec<String>> {
    spawn_blocking(move || crate::discover_repositories(std::path::Path::new(&dir))?
        .into_iter().map(path_string).collect::<Result<Vec<_>>>())
        .await.map_err(|error| napi::Error::from_reason(format!("{error:?}")))?
        .map_err(|error| napi::Error::from_reason(format!("{error:?}")))
}
