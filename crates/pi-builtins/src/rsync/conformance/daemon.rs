//! A reference `rsync --daemon` per side, killed on drop.

use std::fs;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Message of the day every listing and transfer prints (unless `--no-motd`).
const MOTD: &str = "Welcome to the conformance daemon\n";

/// A running daemon serving `w`'s modules:
///
/// - `rw`: `w/rw`, writable;
/// - `ro`: `w/src`, read-only (the default);
/// - `auth`: `w/src`, user `alice` with password `sekrit` (`{BIN}/pw`);
/// - `hidden`: `w/src`, unlisted.
pub(super) struct Daemon {
	child: Child,
	/// The port it listens on.
	pub(super) port: u16,
}

impl Daemon {
	/// Starts the daemon with its config, secrets, motd, and log under `dir`
	/// and waits until it accepts connections.
	pub(super) fn start(reference: &Path, dir: &Path, w: &Path) -> Self {
		fs::create_dir_all(dir).unwrap();
		let secrets = dir.join("secrets");
		fs::write(&secrets, "alice:sekrit\n").unwrap();
		fs::set_permissions(&secrets, fs::Permissions::from_mode(0o600)).unwrap();
		fs::write(dir.join("motd"), MOTD).unwrap();
		let (d, w) = (dir.display(), w.display());
		let conf = format!(
			"pid file = {d}/pid\nlog file = {d}/log\nmotd file = {d}/motd\nuse chroot = no\n\
			 munge symlinks = no\n\n\
			 [rw]\n\tpath = {w}/rw\n\tcomment = read-write module\n\tread only = no\n\n\
			 [ro]\n\tpath = {w}/src\n\tcomment = read-only module\n\n\
			 [auth]\n\tpath = {w}/src\n\tcomment = needs a password\n\tauth users = alice\n\
			 \tsecrets file = {d}/secrets\n\n\
			 [hidden]\n\tpath = {w}/src\n\tlist = no\n"
		);
		let config = dir.join("rsyncd.conf");
		fs::write(&config, conf).unwrap();
		// Another test may grab the port between this probe and the daemon's
		// bind; the readiness wait below then fails loudly rather than flaking
		// silently.
		let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
		let child = Command::new(reference)
			.arg("--daemon")
			.arg("--no-detach")
			.arg(format!("--port={port}"))
			.arg(format!("--config={}", config.display()))
			.env_clear()
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.unwrap();
		let daemon = Self { child, port };
		let deadline = Instant::now() + Duration::from_secs(10);
		while TcpStream::connect(("127.0.0.1", port)).is_err() {
			assert!(Instant::now() < deadline, "reference daemon never listened on port {port}");
			std::thread::sleep(Duration::from_millis(20));
		}
		daemon
	}
}

impl Drop for Daemon {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}
