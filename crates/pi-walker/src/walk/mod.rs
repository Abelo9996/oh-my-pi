//! The parallel directory walker every search traverses with: gitignore-aware,
//! listing-cache-backed, and reading only through [`crate::fs`].
//!
//! It keeps pi's traversal contract (hidden-file, `.git`, and `node_modules`
//! pruning; [`crate::ignore`] semantics; path-ordered collection) while
//! minimising syscalls per directory and spreading directories over worker
//! threads:
//!
//! - [`walk`] visits entries in no particular order on up to
//!   [`Options::workers`] threads; per-worker state comes from `init` and is
//!   handed back afterwards, so visitors need no locking.
//! - [`collect`] gathers the entries a filter keeps, optionally in byte order
//!   of their paths (each worker sorts its directories' share of the order;
//!   collection only concatenates).
//! - [`tree`] is the serial, ordered, streaming traversal for tools whose
//!   output order and pruning decisions are sequential (`find`, `fd`, workspace
//!   listing).
//!
//! Directories open relative to their parent's handle, ignore files are read
//! only when a listing contains them, unchanged directories are served from
//! the process-wide listing cache ([`cache`]), and visitors open files through
//! [`Worker::open_file`], relative to the directory being visited. Entry paths
//! are carved from per-worker arenas, so steady-state walking allocates a few
//! objects per directory, not per entry.
//!
//! ```ignore
//! let walked = walk::walk(&fs, root, &opts, &Never, || 0usize, |count, _, entry| {
//!     if entry.file_type == FileType::File { *count += 1 }
//!     walk::Action::Continue
//! })?;
//! let files: usize = walked.states.iter().sum();
//! ```

mod arena;
mod cache;
mod parallel;
pub mod tree;

use std::{
	borrow::Cow,
	ffi::OsString,
	fmt, io,
	path::{Path, PathBuf},
	sync::LazyLock,
};

use parking_lot::Mutex;
pub use tree::{Completion, Event, Follow, TreeEntry, TreeOptions, tree};

use self::{arena::Arena, parallel::Stored};
use crate::fs::{Detail, Dir, File, FileInfo, FileType, Fs, Session};

/// Cooperative cancellation: walks and searches poll it between directories
/// and files and end with [`WalkError::Stopped`] once it reports true.
pub trait Stop: Sync {
	/// Whether the operation should end now.
	fn stop(&self) -> bool;
}

impl<F: Fn() -> bool + Sync> Stop for F {
	fn stop(&self) -> bool {
		self()
	}
}

/// A [`Stop`] that never fires.
#[derive(Clone, Copy, Debug, Default)]
pub struct Never;

impl Stop for Never {
	fn stop(&self) -> bool {
		false
	}
}

/// Traversal options shared by [`walk`] and [`collect`]. The default walks
/// everything except hidden entries, honouring no ignore files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Options {
	/// Include dot-prefixed entries.
	pub hidden:            bool,
	/// Honour `.ignore`, `.gitignore`, `.git/info/exclude`, and git's global
	/// excludes ([`crate::ignore`]).
	pub gitignore:         bool,
	/// Prune entries named `.git`.
	pub skip_git:          bool,
	/// Prune entries named `node_modules`.
	pub skip_node_modules: bool,
	/// Report symlinks as their targets (type, size, mtime) and descend into
	/// linked directories. Dangling links, links to special files, and links
	/// to a directory enclosing them (which would loop) are left out. The
	/// root itself is always resolved through symlinks.
	pub follow_links:      bool,
	/// Listing metadata; [`Detail::Full`] is needed for sizes and mtimes.
	pub detail:            Detail,
	/// Deepest entry depth reported (root's children are depth 1); `None`
	/// is unlimited.
	pub max_depth:         Option<usize>,
	/// Do not descend into directories on another filesystem than the root
	/// (they are still reported).
	pub same_file_system:  bool,
	/// Walking threads; `None` (or 0) picks `PI_WALK_WORKERS` when set, else
	/// [`Fs::workers`].
	pub workers:           Option<usize>,
	/// Reuse unchanged directories' listings from earlier walks ([`cache`]).
	/// Only [`Detail::Minimal`] native walks consult it.
	pub cache:             bool,
}

impl Options {
	/// Threads a walk of `fs` with these options runs on: [`Self::workers`],
	/// else `PI_WALK_WORKERS` (0 = auto, 1 = serial), else [`Fs::workers`],
	/// capped by the machine's parallelism.
	pub fn parallelism(&self, fs: &Fs) -> usize {
		static ENV: LazyLock<Option<usize>> = LazyLock::new(|| {
			std::env::var("PI_WALK_WORKERS")
				.ok()
				.and_then(|value| value.trim().parse::<usize>().ok())
				.filter(|&workers| workers > 0)
		});
		static CPUS: LazyLock<usize> =
			LazyLock::new(|| std::thread::available_parallelism().map_or(1, std::num::NonZero::get));
		let workers = self
			.workers
			.filter(|&workers| workers > 0)
			.or(*ENV)
			.unwrap_or_else(|| fs.workers());
		workers.clamp(1, (*CPUS).max(1))
	}
}

/// One walked entry. Paths are relative to the walk root, `/`-separated raw
/// name bytes; borrowed entries are only valid during the callback.
#[derive(Clone, Copy, Debug)]
pub struct Entry<'a> {
	/// Walk-relative path.
	pub path:      &'a [u8],
	/// Entry kind (a followed symlink's target kind).
	pub file_type: FileType,
	/// 1 for the root's children.
	pub depth:     usize,
	/// Regular-file size, when known ([`Detail::Full`], Windows listings, or
	/// a followed link).
	pub size:      Option<u64>,
	/// Modification time in Unix nanoseconds, when known.
	pub mtime:     Option<i64>,
}

impl<'a> Entry<'a> {
	/// Final path component.
	pub fn name(&self) -> &'a [u8] {
		match memchr::memrchr(b'/', self.path) {
			Some(slash) => &self.path[slash + 1..],
			None => self.path,
		}
	}

	/// The path as text, with invalid UTF-8 replaced.
	pub fn path_lossy(&self) -> Cow<'a, str> {
		String::from_utf8_lossy(self.path)
	}

	/// The walk-relative path as a [`Path`] (`/`-separated).
	pub fn rel_path(&self) -> &'a Path {
		rel_path(self.path)
	}
}

/// How a visitor or filter steers the walk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
	/// Keep the entry; directories are descended.
	Continue,
	/// Leave the entry out of a [`collect`] but still descend into it.
	Skip,
	/// Leave the entry out and do not descend into it.
	SkipDir,
	/// End the walk as soon as in-flight directories finish.
	Stop,
}

/// A directory below the root that could not be opened or listed.
#[derive(Debug)]
pub struct DirError {
	/// Absolute path in the walked filesystem's spelling.
	pub path:  PathBuf,
	/// What failed.
	pub error: io::Error,
}

/// Why a walk ended without a result.
#[derive(Debug)]
pub enum WalkError {
	/// The root could not be opened as a directory.
	Root {
		/// The root as given.
		path:  PathBuf,
		/// What failed.
		error: io::Error,
	},
	/// [`Stop`] fired.
	Stopped,
}

impl fmt::Display for WalkError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Root { path, error } => write!(f, "{}: {error}", path.display()),
			Self::Stopped => f.write_str("walk stopped"),
		}
	}
}

impl std::error::Error for WalkError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::Root { error, .. } => Some(error),
			Self::Stopped => None,
		}
	}
}

/// One walking thread, as seen by visitors and filters.
pub struct Worker<'w> {
	id:      usize,
	fs:      &'w Fs,
	root:    &'w Path,
	session: &'w mut Session,
	abs:     &'w mut PathBuf,
	/// The directory being emitted, when the walk holds it open.
	dir:     Option<&'w Dir>,
}

impl Worker<'_> {
	/// The worker's index, `0 <= id < workers`.
	pub const fn id(&self) -> usize {
		self.id
	}

	/// The worker's filesystem session, for anything else a visitor reads.
	pub const fn session(&mut self) -> &mut Session {
		&mut *self.session
	}

	/// Absolute path of `entry` (the entry being visited) in the walked
	/// filesystem's spelling; valid until the next call.
	pub fn abs(&mut self, entry: &Entry<'_>) -> &Path {
		join_into(self.fs, self.root, entry.path, self.abs);
		self.abs.as_path()
	}

	/// Opens the regular file `entry` (the entry being visited) for reading.
	/// While the walk holds the entry's directory open the file is opened
	/// relative to it (a one-component lookup); entries served from the
	/// listing cache are opened by absolute path.
	pub fn open_file(&mut self, entry: &Entry<'_>) -> io::Result<(File, FileInfo)> {
		if let Some(dir) = self.dir {
			return self.session.open_file_at(dir, entry.name());
		}
		join_into(self.fs, self.root, entry.path, self.abs);
		self.session.open_file(self.abs.as_path())
	}
}

/// Per-worker states and the directory errors of a finished [`walk`].
#[derive(Debug)]
pub struct Walked<S> {
	/// One state per worker that ran, in worker-id order (helpers start only
	/// once there is work to share).
	pub states: Vec<S>,
	/// Directories below the root that could not be read, in no particular
	/// order.
	pub errors: Vec<DirError>,
}

/// Visits every entry below `root` that `opts` admits.
///
/// In no particular
/// order, calling `visit` concurrently from the workers with that worker's
/// state (made by `init`). A directory's [`Action::SkipDir`] prunes it,
/// [`Action::Stop`] ends the walk; `Skip` and `Continue` are the same here.
/// Unreadable directories below the root are skipped and reported in
/// [`Walked::errors`].
///
/// # Errors
/// [`WalkError::Root`] when `root` cannot be opened as a directory;
/// [`WalkError::Stopped`] when `stop` fires.
pub fn walk<S, I, V>(
	fs: &Fs,
	root: &Path,
	opts: &Options,
	stop: &dyn Stop,
	init: I,
	visit: V,
) -> Result<Walked<S>, WalkError>
where
	S: Send,
	I: Fn() -> S + Sync,
	V: Fn(&mut S, &mut Worker<'_>, &Entry<'_>) -> Action + Sync,
{
	let sink = parallel::WalkSink::<S, I, V>::new(init, visit);
	let out = parallel::run(fs, root, opts, stop, &sink, false, default_cache(fs, opts))?;
	Ok(Walked { states: out.states, errors: out.errors })
}

/// Entries kept by a [`collect`], owning their paths in shared arenas.
#[derive(Debug, Default)]
pub struct Collection {
	entries: Vec<Stored>,
	/// Owners of every `entries` path; never read directly.
	_arenas: Vec<Arena>,
	errors:  Vec<DirError>,
}

impl Collection {
	/// Number of kept entries.
	pub const fn len(&self) -> usize {
		self.entries.len()
	}

	/// Nothing was kept.
	pub const fn is_empty(&self) -> bool {
		self.len() == 0
	}

	/// The `index`th entry.
	pub fn get(&self, index: usize) -> Entry<'_> {
		let stored = &self.entries[index];
		Entry {
			// SAFETY: every stored path lives in one of `self._arenas`, which
			// are owned by `self` and never written below their used length.
			path:      unsafe { stored.path.get() },
			file_type: stored.file_type,
			depth:     stored.depth,
			size:      stored.size,
			mtime:     stored.mtime,
		}
	}

	/// Kept entries in collection order.
	pub fn iter(&self) -> impl ExactSizeIterator<Item = Entry<'_>> + '_ {
		(0..self.len()).map(|index| self.get(index))
	}

	/// Directories below the root that could not be read.
	pub fn errors(&self) -> &[DirError] {
		&self.errors
	}
}

/// Collects the entries below `root` that `filter` keeps.
///
/// The filter returns [`Action::Continue`] to keep an entry; `Skip` drops an
/// entry, `SkipDir` drops a directory
/// with its subtree, `Stop` ends the walk keeping what was collected. The
/// filter runs concurrently on the workers and may rewrite a kept entry's
/// `file_type`, `size`, and `mtime` (say, to describe a symlink's target);
/// descent still follows the listed type. With `sorted`, entries come back in
/// byte order of their paths; otherwise in no particular order.
///
/// # Errors
/// As for [`walk`].
pub fn collect<F>(
	fs: &Fs,
	root: &Path,
	opts: &Options,
	sorted: bool,
	stop: &dyn Stop,
	filter: F,
) -> Result<Collection, WalkError>
where
	F: Fn(&mut Worker<'_>, &mut Entry<'_>) -> Action + Sync,
{
	collect_in(fs, root, opts, sorted, stop, filter, default_cache(fs, opts))
}

/// [`collect`] against an explicit listing cache.
fn collect_in<F>(
	fs: &Fs,
	root: &Path,
	opts: &Options,
	sorted: bool,
	stop: &dyn Stop,
	filter: F,
	cache: Option<&cache::Cache>,
) -> Result<Collection, WalkError>
where
	F: Fn(&mut Worker<'_>, &mut Entry<'_>) -> Action + Sync,
{
	let sink = parallel::CollectSink::new(filter);
	let out = parallel::run(fs, root, opts, stop, &sink, sorted, cache)?;
	Ok(Collection { entries: out.entries, _arenas: out.arenas, errors: out.errors })
}

/// The process-wide cache when `opts` asks for it and the walk can use it.
fn default_cache(fs: &Fs, opts: &Options) -> Option<&'static cache::Cache> {
	opts.cache.then(cache::global).filter(|_| fs.is_native())
}

/// Whether `name` is pruned by the hidden, `.git`, and `node_modules` rules.
pub(crate) fn pruned(name: &[u8], hidden: bool, skip_git: bool, skip_node_modules: bool) -> bool {
	(!hidden && name.first() == Some(&b'.'))
		|| (skip_git && name == b".git")
		|| (skip_node_modules && name == b"node_modules")
}

/// A walk-relative path as a [`Path`].
pub(crate) fn rel_path(bytes: &[u8]) -> &Path {
	// SAFETY: walk paths are listed names (`OsStr::as_encoded_bytes`, see
	// `fs::Listing`) joined with ASCII `/`, which keeps them valid encoded
	// `OsStr` bytes.
	Path::new(unsafe { std::ffi::OsStr::from_encoded_bytes_unchecked(bytes) })
}

pub(crate) const fn is_separator(byte: u8) -> bool {
	byte == b'/' || (cfg!(windows) && byte == b'\\')
}

/// The host path separator.
const SEP: u8 = if cfg!(windows) { b'\\' } else { b'/' };

/// Absolute root spelling a walk joins entry paths to: native relative roots
/// are made absolute against the working directory; provider roots stay as
/// given.
pub(crate) fn absolute_root(fs: &Fs, root: &Path) -> PathBuf {
	if fs.is_native() && root.is_relative() {
		std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf())
	} else {
		root.to_path_buf()
	}
}

/// Writes the absolute spelling of walk-relative `rel` below `root` into
/// `out`, reusing its buffer for native paths.
pub(crate) fn join_into(fs: &Fs, root: &Path, rel: &[u8], out: &mut PathBuf) {
	if !fs.is_native() {
		*out = fs.join(root, rel);
		return;
	}
	let mut bytes = std::mem::take(out).into_os_string().into_encoded_bytes();
	bytes.clear();
	bytes.extend_from_slice(root.as_os_str().as_encoded_bytes());
	if !rel.is_empty() {
		if !bytes.last().is_some_and(|&byte| is_separator(byte)) {
			bytes.push(SEP);
		}
		let start = bytes.len();
		bytes.extend_from_slice(rel);
		if cfg!(windows) {
			for byte in &mut bytes[start..] {
				if *byte == b'/' {
					*byte = b'\\';
				}
			}
		}
	}
	// SAFETY: `bytes` concatenates an encoded `OsStr`, ASCII separators, and
	// raw names that came from encoded `OsStr` listings.
	*out = PathBuf::from(unsafe { OsString::from_encoded_bytes_unchecked(bytes) });
}

/// Like [`join_into`] for the child `name` of the walk-relative directory
/// `dir`.
pub(crate) fn join_child_into(fs: &Fs, root: &Path, dir: &[u8], name: &[u8], out: &mut PathBuf) {
	if !fs.is_native() {
		let parent = fs.join(root, dir);
		*out = fs.join(&parent, name);
		return;
	}
	join_into(fs, root, dir, out);
	let mut bytes = std::mem::take(out).into_os_string().into_encoded_bytes();
	if !bytes.last().is_some_and(|&byte| is_separator(byte)) {
		bytes.push(SEP);
	}
	bytes.extend_from_slice(name);
	// SAFETY: as in `join_into`; `name` is a raw listed name.
	*out = PathBuf::from(unsafe { OsString::from_encoded_bytes_unchecked(bytes) });
}

/// Native sessions kept between walks, so each walk does not pay for fresh
/// listing buffers.
static SESSIONS: Mutex<Vec<Session>> = Mutex::new(Vec::new());

/// Most pooled sessions kept.
const MAX_POOLED_SESSIONS: usize = 32;

/// A session for `fs`, reused from an earlier walk when possible.
pub(crate) fn take_session(fs: &Fs) -> Session {
	if fs.is_native()
		&& let Some(session) = SESSIONS.lock().pop()
	{
		return session;
	}
	fs.session()
}

/// Returns a session from [`take_session`] for reuse.
pub(crate) fn give_session(fs: &Fs, session: Session) {
	if fs.is_native() {
		let mut pool = SESSIONS.lock();
		if pool.len() < MAX_POOLED_SESSIONS {
			pool.push(session);
		}
	}
}

#[cfg(test)]
mod tests;
