use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use crate::{Cabaret, Result, WorkspaceIdRef};

/// Find the checkout containing `dir`, or repositories immediately below a container directory.
/// Sibling worktrees are one repository, identified by the canonical common Git directory.
/// This never recursively scans the container and never initializes a repository.
pub fn discover_repositories(dir: &Path) -> Result<Vec<PathBuf>> {
    if let Ok(repository) = Cabaret::open(dir) {
        let workspace = repository
            .workspace_current()
            .and_then(|id| repository.workspace_path(id.to_ref()))
            .unwrap_or_else(|_| dir.to_owned());
        return Ok(vec![fs::canonicalize(workspace)?]);
    }
    // A broken checkout should retain its original error, not become a container.
    if dir.join(".git").exists() {
        Cabaret::open(dir)?;
    }
    let mut repositories = BTreeMap::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if !path.is_dir() || !path.join(".git").exists() {
            continue;
        }
        let Ok(repository) = Cabaret::open(&path) else { continue };
        let common = fs::canonicalize(repository.common_dir())?;
        // Prefer the main checkout so container-level commands do not target an arbitrary feature.
        let workspace = repository
            .workspace_path(WorkspaceIdRef::Main)
            .or_else(|_| repository.workspace_path(repository.workspace_current()?.to_ref()))?;
        repositories.entry(common).or_insert(fs::canonicalize(workspace)?);
    }
    Ok(repositories.into_values().collect())
}
