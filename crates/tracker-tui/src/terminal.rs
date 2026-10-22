//! The outer run loop: owns the terminal, feeds input and background
//! results into `Model::update`, and redraws after every change.
//!
//! There is no frame tick. In the Go build, Bubble Tea's renderer ticker
//! bounded keypress latency; here each handled event is followed by an
//! immediate draw, and ratatui's buffer diff keeps redraws cheap.

use std::io::{self, Stdout, Write};
use std::panic;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result};
use crossterm::event::{self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;

use tracker_app::{Cmd, Model, Msg, Services};

use crate::Deps;
use crate::app::{execute, key_press};
use crate::view::Draw;

/// Writes the escape sequences that set up the screen. Clearing here rather
/// than with `Terminal::clear` avoids a cursor-position query that can stall
/// on terminals that never answer it.
fn enter_screen(out: &mut impl Write) -> io::Result<()> {
    execute!(out, EnterAlternateScreen, Clear(ClearType::All), EnableBracketedPaste)
}

/// Writes the escape sequences that undo [`enter_screen`].
fn leave_screen(out: &mut impl Write) -> io::Result<()> {
    execute!(out, DisableBracketedPaste, LeaveAlternateScreen, crossterm::cursor::Show)
}

/// Best-effort restore, shared by `Drop` and the panic hook.
fn restore_terminal() {
    let _ = terminal::disable_raw_mode();
    let _ = leave_screen(&mut io::stdout());
}

type PanicHook = Box<dyn Fn(&panic::PanicHookInfo<'_>) + Send + Sync + 'static>;

/// Puts the terminal in raw mode on the alternate screen with bracketed
/// paste, and restores it when dropped (normal exit or error) or when the
/// UI thread panics.
struct TerminalGuard {
    previous_hook: Arc<Mutex<Option<PanicHook>>>,
}

impl TerminalGuard {
    fn enter() -> Result<TerminalGuard> {
        let previous_hook = Arc::new(Mutex::new(Some(panic::take_hook())));
        let hook = Arc::clone(&previous_hook);
        let ui_thread = thread::current().id();
        panic::set_hook(Box::new(move |info| {
            // Worker panics are caught and reported through the UI, so only
            // a UI-thread panic should tear the screen down and print.
            if thread::current().id() != ui_thread {
                return;
            }
            restore_terminal();
            if let Some(previous) = hook.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
                previous(info);
            }
        }));

        // Construct the guard first so a failure below still restores.
        let guard = TerminalGuard { previous_hook };
        terminal::enable_raw_mode().context("enable raw mode")?;
        enter_screen(&mut io::stdout()).context("enter alternate screen")?;
        Ok(guard)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal();
        // `set_hook` panics on a panicking thread. Our hook then stays
        // installed, still delegating to the previous one.
        if thread::panicking() {
            return;
        }
        let previous = self.previous_hook.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(previous) = previous {
            panic::set_hook(previous);
        }
    }
}

/// Converts a terminal event to a model message, dropping what the model
/// ignores (mouse, focus, key releases).
fn message_for(event: Event) -> Option<Msg> {
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => key_press(&key).map(Msg::Key),
        Event::Paste(content) => Some(Msg::Paste(content)),
        Event::Resize(width, height) => Some(Msg::Resize { width, height }),
        _ => None,
    }
}

/// Executes commands. Input and background results arrive on one channel,
/// so whichever comes first wakes the loop with no polling delay.
struct Runner {
    deps: Deps,
    sender: Sender<io::Result<Msg>>,
    receiver: Receiver<io::Result<Msg>>,
}

enum Flow {
    Continue,
    Quit,
}

impl Runner {
    fn dispatch(&mut self, cmd: Option<Cmd>) -> Result<Flow> {
        match cmd {
            None => Ok(Flow::Continue),
            Some(Cmd::Quit) => Ok(Flow::Quit),
            Some(cmd) => {
                let sender = self.sender.clone();
                let deps = self.deps.clone();
                thread::Builder::new()
                    .name("tracker-tui-worker".into())
                    .spawn(move || {
                        if let Some(msg) = execute(&deps, cmd) {
                            // The receiver is gone only if the UI already quit.
                            let _ = sender.send(Ok(msg));
                        }
                    })
                    .context("spawn background worker")?;
                Ok(Flow::Continue)
            }
        }
    }

    fn apply(&mut self, model: &mut Model, msg: Msg) -> Result<Flow> {
        let cmd = model.update(msg);
        self.dispatch(cmd)
    }
}

/// Takes over the terminal until the user quits.
pub(crate) fn run(deps: Deps) -> Result<()> {
    let guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout())).context("create terminal")?;
    let result = event_loop(&mut terminal, deps, Model::new(Services::ALL));
    drop(guard);
    result
}

fn event_loop(terminal: &mut Terminal<CrosstermBackend<Stdout>>, deps: Deps, mut model: Model) -> Result<()> {
    let (sender, receiver) = mpsc::channel();
    spawn_input_reader(sender.clone())?;
    let mut runner = Runner { deps, sender, receiver };

    let (width, height) = terminal::size().context("read terminal size")?;
    model.update(Msg::Resize { width, height });
    let init = model.init();
    runner.dispatch(init)?;

    loop {
        terminal.draw(|frame| model.render(frame)).context("draw frame")?;
        if let Flow::Quit = runner.wait_for_change(&mut model)? {
            return Ok(());
        }
    }
}

/// Forwards terminal input into the model's channel. The thread blocks in
/// `event::read` for the life of the process; it is detached rather than
/// joined because the process exits right after the UI quits.
fn spawn_input_reader(sender: Sender<io::Result<Msg>>) -> Result<()> {
    thread::Builder::new()
        .name("tracker-tui-input".into())
        .spawn(move || {
            loop {
                let msg = match event::read() {
                    Ok(event) => match message_for(event) {
                        Some(msg) => Ok(msg),
                        None => continue,
                    },
                    Err(err) => Err(err),
                };
                let failed = msg.is_err();
                // The receiver is gone only if the UI already quit.
                if sender.send(msg).is_err() || failed {
                    return;
                }
            }
        })
        .context("spawn input reader")?;
    Ok(())
}

impl Runner {
    /// Blocks until a message arrives, then applies it and everything else
    /// already queued, so a burst (held key, fast typing, a result landing
    /// mid-typing) costs one frame instead of one per message.
    fn wait_for_change(&mut self, model: &mut Model) -> Result<Flow> {
        let mut next = Some(self.receiver.recv().context("UI channel closed")?);
        while let Some(msg) = next {
            if let Flow::Quit = self.apply(model, msg.context("read terminal event")?)? {
                return Ok(Flow::Quit);
            }
            next = self.receiver.try_recv().ok();
        }
        Ok(Flow::Continue)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn screen_setup_uses_alt_screen_and_bracketed_paste() {
        let mut out = Vec::new();
        enter_screen(&mut out).unwrap();
        let setup = String::from_utf8(out).unwrap();
        assert!(setup.contains("\x1b[?1049h"), "setup = {setup:?}, want the alternate screen");
        assert!(setup.contains("\x1b[?2004h"), "setup = {setup:?}, want bracketed paste");

        let mut out = Vec::new();
        leave_screen(&mut out).unwrap();
        let teardown = String::from_utf8(out).unwrap();
        assert!(teardown.contains("\x1b[?1049l") && teardown.contains("\x1b[?2004l"), "teardown = {teardown:?}");
    }

    #[test]
    fn terminal_events_map_to_messages() {
        use crossterm::event::{KeyCode, KeyEvent, KeyEventState, KeyModifiers};

        let release = KeyEvent {
            code: KeyCode::Char('j'),
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Release,
            state: KeyEventState::NONE,
        };
        assert!(message_for(Event::Key(release)).is_none());
        assert!(matches!(
            message_for(Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE))),
            Some(Msg::Key(_))
        ));
        assert!(matches!(message_for(Event::Paste("x".into())), Some(Msg::Paste(text)) if text == "x"));
        assert!(matches!(message_for(Event::Resize(80, 24)), Some(Msg::Resize { width: 80, height: 24 })));
        assert!(message_for(Event::FocusGained).is_none());
    }

    #[test]
    fn runner_runs_tasks_in_background() {
        use std::sync::Arc;

        use anyhow::anyhow;

        let (sender, receiver) = mpsc::channel();
        let deps = Deps {
            load: Arc::new(|| Err(anyhow!("database is locked"))),
            sync: Arc::new(|| unreachable!()),
            save_rating: Arc::new(|_| unreachable!()),
        };
        let mut runner = Runner { deps, sender, receiver };
        let mut model = Model::default();
        assert!(matches!(runner.dispatch(None).unwrap(), Flow::Continue));
        assert!(matches!(runner.dispatch(Some(Cmd::Quit)).unwrap(), Flow::Quit));
        assert!(matches!(runner.dispatch(model.init()).unwrap(), Flow::Continue));
        let msg = runner.receiver.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert!(matches!(msg, Msg::TracksLoaded(Err(_))), "a failed load reports an error");
    }
}
