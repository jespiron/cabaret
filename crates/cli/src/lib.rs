use std::path::PathBuf;

use cabaret_lib::{Cabaret, Identity, Result};
use clap::{Parser, Subcommand, ValueHint};

pub mod args;
pub mod change;
pub mod config;
pub mod diff;
pub mod workspace;

use crate::{change::ChangeCommand, config::ConfigCommand, workspace::WorkspaceCommand};

#[derive(Subcommand)]
enum Command {
    Change {
        #[command(subcommand)]
        command: ChangeCommand,
    },
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Exchange change logs and branches with origin: merge its logs into yours, fast-forward
    /// your branches to its, then push yours back. Only origin's default branch and those of open
    /// changes with logs are exchanged; the rest are fetched as refs/remotes/origin/*.
    Fetch,
    /// Show your open changes as a stack graph.
    Home {
        /// Identity to view as; defaults to git's user.email.
        #[arg(long = "as")]
        viewer: Option<Identity>,
    },
    /// Make a new repository. An empty directory gets one laid out with a workspace per change
    /// beside it; a directory with contents becomes the main workspace, as git init does.
    Init {
        /// Directory to initialize in
        #[arg(value_hint = ValueHint::DirPath)]
        dir: Option<PathBuf>,
        /// Clone this repository instead of starting empty.
        #[arg(long)]
        from: Option<String>,
    },
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
}

#[derive(Parser)]
#[command(name = "cab", version, about = "Cabaret Code Review")]
pub struct Cli {
    /// Run in this checkout or repository container.
    #[arg(short = 'C', global = true, value_hint = ValueHint::DirPath)]
    directory: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

pub fn run() -> Result<()> {
    let cli = Cli::parse();
    if let Some(dir) = cli.directory {
        std::env::set_current_dir(dir)?;
    }
    let cabaret = || {
        let dir = std::env::current_dir()?;
        let repositories = cabaret_lib::discover_repositories(&dir)?;
        match repositories.as_slice() {
            [repository] => Cabaret::open(repository),
            [] => Err(format!("no Git repository found in {} or its immediate children", dir.display()).into()),
            _ => Err(format!("multiple repositories found; choose one with cab -C <path>:\n{}",
                repositories.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join("\n")).into()),
        }
    };

    match cli.command {
        Command::Change { command } => command.run(&cabaret()?)?,
        Command::Config { command } => command.run(cabaret()?)?,
        Command::Fetch => {
            for (change, reason) in cabaret()?.fetch()? {
                println!("kept {change}: {reason}");
            }
        }
        Command::Home { viewer } => {
            let cabaret = cabaret()?;
            let viewer = match viewer {
                Some(viewer) => viewer,
                None => cabaret.identity()?,
            };
            print!("{}", cabaret.home_page(&viewer)?);
        }
        Command::Init { dir, from } => {
            let dir = match dir {
                Some(dir) => dir,
                None => std::env::current_dir()?,
            };
            Cabaret::init(&dir, from.as_deref())?;
        }
        Command::Workspace { command } => command.run(&cabaret()?)?,
    }

    Ok(())
}
