use super::fixture::{Fixture, alice};
use cabaret_lib::discover_repositories;
use std::fs;

#[test]
fn a_container_groups_linked_worktrees_and_prefers_main() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a.txt", "a")]);
    fixture.create("one", "main", &alice());
    fixture.create("two", "main", &alice());
    let one = fixture.add_workspace("one");
    fixture.add_workspace("two");
    let main = fs::canonicalize(fixture.path("main")).unwrap();
    assert_eq!(discover_repositories(&fixture.path("")).unwrap(), vec![main.clone()]);
    let nested = one.workdir().unwrap().join("nested");
    fs::create_dir(&nested).unwrap();
    assert_eq!(
        discover_repositories(&nested).unwrap(),
        vec![fs::canonicalize(one.workdir().unwrap()).unwrap()]
    );
    // A second independent clone/repository must not be conflated with the first.
    gix::init(fixture.path("other")).unwrap();
    let discovered = discover_repositories(&fixture.path("")).unwrap();
    assert_eq!(discovered.len(), 2);
    assert!(discovered.contains(&main));
}

#[test]
fn discovery_is_shallow_and_does_not_initialize_directories() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("nested")).unwrap();
    gix::init(root.path().join("nested/deeper")).unwrap();
    assert!(discover_repositories(root.path()).unwrap().is_empty());
    assert!(!root.path().join(".git").exists());
}

#[test]
fn cabarets_bare_container_layout_still_opens() {
    let fixture = Fixture::bare();
    assert_eq!(
        discover_repositories(&fixture.path("project")).unwrap(),
        vec![fixture.path("project")]
    );
}

#[cfg(unix)]
#[test]
fn symlinked_checkouts_are_deduplicated() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink(fixture.path("main"), fixture.path("alias")).unwrap();
    assert_eq!(
        discover_repositories(&fixture.path("")).unwrap(),
        vec![fixture.path("main")]
    );
}
