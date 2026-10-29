//! Serial, ordered, streaming depth-first traversal.
//!
//! [`tree`] is for tools whose output order and pruning are sequential:
//! `find` (pre-order or `-depth` contents-first, `-prune`, `-quit`, `-xdev`,
//! `-L`/`-H`), `fd`, and workspace listing. It shares the filesystem layer,
//! ignore chain, and pruning rules of [`super::walk`], but visits on the
//! calling thread, one directory at a time, and lets the visitor decide each
//! entry before its subtree is read.
//!
//! ```ignore
//! let opts = TreeOptions { emit_root: true, ..Default::default() };
//! tree(&fs, root, &opts, &Never, |event| match event {
//!     Event::Entry(entry) => { println!("{}", entry.abs.display()); Action::Continue }
//!     Event::Error(error) => { eprintln!("{}: {}", error.path.display(), error.error); Action::Continue }
//! })?;
//! ```

use std::{ffi::OsStr, io, path::Path, sync::Arc};

use super::{
	Action, DirError, SEP, Stop, WalkError, absolute_root, give_session, is_separator, pruned,
	take_session,
};
use crate::{
	fs::{Detail, Dir, FileId, FileType, Fs, Listing, Record, Session},
	ignore::{DirIgnores, Frame as IgnoreFrame, Ignorer, Names},
};

/// Which symlinks a [`tree`] follows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Follow {
	/// None, not even a root that is a symlink (it is reported as one).
	Never,
	/// Only the root (`find -H`, `grep -r`, `fd` without `-L`).
	#[default]
	Roots,
	/// Every link, with loop detection (`find -L`, `fd -L`).
	Always,
}

/// Order in which a [`tree`] visits each directory's entries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Order {
	/// As the directory listing returns them.
	Listing,
	/// Byte order of their names (`find`, `fd`).
	#[default]
	Names,
	/// Byte order of the paths of the files below: a listed directory sorts
	/// as its name plus `/`, so files are visited in the byte order of their
	/// full paths, the order a sorted [`super::collect`] returns.
	Paths,
}

/// Options of a [`tree`] traversal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeOptions {
	/// Include dot-prefixed entries.
	pub hidden:            bool,
	/// Honour the ignore chain ([`crate::ignore`]).
	pub gitignore:         bool,
	/// Prune entries named `.git`.
	pub skip_git:          bool,
	/// Prune entries named `node_modules`.
	pub skip_node_modules: bool,
	/// Symlink policy.
	pub follow:            Follow,
	/// Listing metadata.
	pub detail:            Detail,
	/// Entries deeper than this are listed with [`Detail::Minimal`]; `None`
	/// applies `detail` everywhere.
	pub detail_max_depth:  Option<usize>,
	/// Order of each directory's entries.
	pub order:             Order,
	/// Report the root itself (depth 0, empty `path`) when `min_depth` is 0.
	pub emit_root:         bool,
	/// Shallowest depth reported; shallower entries are still traversed.
	pub min_depth:         usize,
	/// Deepest depth listed; `None` is unlimited. `min_depth > max_depth`
	/// reports nothing.
	pub max_depth:         Option<usize>,
	/// Report a directory after its contents (`find -depth`) instead of
	/// before.
	pub contents_first:    bool,
	/// Do not descend into directories on another filesystem than the root
	/// (they are still reported).
	pub same_file_system:  bool,
	/// A file name exempt from ignore rules (workspace listing's
	/// `AGENTS.md`); ignored directories are still pruned.
	pub unignored_name:    Option<&'static str>,
}

impl Default for TreeOptions {
	fn default() -> Self {
		Self {
			hidden:            true,
			gitignore:         false,
			skip_git:          false,
			skip_node_modules: false,
			follow:            Follow::Roots,
			detail:            Detail::Minimal,
			detail_max_depth:  None,
			order:             Order::Names,
			emit_root:         false,
			min_depth:         1,
			max_depth:         None,
			contents_first:    false,
			same_file_system:  false,
			unignored_name:    None,
		}
	}
}

/// One entry reported by [`tree`].
#[derive(Clone, Copy, Debug)]
pub struct TreeEntry<'a> {
	/// Walk-relative `/`-separated raw path; empty for the root.
	pub path:      &'a [u8],
	/// Absolute path in the walked filesystem's spelling.
	pub abs:       &'a Path,
	/// Entry kind; a followed symlink reports its target's kind.
	pub file_type: FileType,
	/// 0 for the root.
	pub depth:     usize,
	/// Regular-file size, when known.
	pub size:      Option<u64>,
	/// Modification time in Unix nanoseconds, when known.
	pub mtime:     Option<i64>,
}

impl<'a> TreeEntry<'a> {
	/// The walk-relative path as a [`Path`] (`/`-separated; empty for the
	/// root).
	pub fn rel_path(&self) -> &'a Path {
		super::rel_path(self.path)
	}

	/// Final path component (empty for the root).
	pub fn name(&self) -> &'a [u8] {
		match memchr::memrchr(b'/', self.path) {
			Some(slash) => &self.path[slash + 1..],
			None => self.path,
		}
	}
}

/// What [`tree`] reports.
#[derive(Debug)]
pub enum Event<'a> {
	/// An entry. [`Action::Skip`] and [`Action::Continue`] both descend a
	/// directory; [`Action::SkipDir`] prunes it; [`Action::Stop`] ends the
	/// traversal.
	Entry(TreeEntry<'a>),
	/// A directory (the root included) that could not be opened or listed,
	/// or a followed link that would loop. [`Action::Stop`] ends the
	/// traversal; anything else continues.
	Error(&'a DirError),
}

/// How a [`tree`] ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completion {
	/// Every entry was visited.
	Complete,
	/// The visitor returned [`Action::Stop`].
	Stopped,
}

/// Visits the entries below `root` depth first on the calling thread. Under
/// [`Follow::Never`] a symlinked root is reported (if `emit_root`) and not
/// descended.
///
/// # Errors
/// [`WalkError::Root`] when `root` does not exist; [`WalkError::Stopped`]
/// when `stop` fires (polled per directory and every 128 entries).
pub fn tree(
	fs: &Fs,
	root: &Path,
	opts: &TreeOptions,
	stop: &dyn Stop,
	mut visit: impl FnMut(Event<'_>) -> Action,
) -> Result<Completion, WalkError> {
	if opts.max_depth.is_some_and(|max| opts.min_depth > max) {
		return Ok(Completion::Complete);
	}
	if stop.stop() {
		return Err(WalkError::Stopped);
	}
	let abs_root = absolute_root(fs, root);
	let mut session = take_session(fs);
	let result = run(fs, root, &abs_root, opts, stop, &mut session, &mut visit);
	give_session(fs, session);
	result
}

/// Polls of [`Stop`] happen every this many entries (and per directory).
const STOP_INTERVAL: usize = 128;

/// Directory handles kept open down the stack for relative child opens;
/// deeper directories open by path, so deep trees cannot exhaust
/// descriptors.
const MAX_OPEN_DIRS: usize = 64;

fn run<V: FnMut(Event<'_>) -> Action>(
	fs: &Fs,
	given: &Path,
	root: &Path,
	opts: &TreeOptions,
	stop: &dyn Stop,
	session: &mut Session,
	visit: &mut V,
) -> Result<Completion, WalkError> {
	let root_error = |error| WalkError::Root { path: given.to_path_buf(), error };
	let follow_root = opts.follow != Follow::Never;
	let info = match session.stat(root, follow_root) {
		Ok(info) => info,
		// A dangling root link is reported as the link.
		Err(error) if follow_root && error.kind() == io::ErrorKind::NotFound => {
			session.stat(root, false).map_err(|_| root_error(error))?
		},
		Err(error) => return Err(root_error(error)),
	};
	let Some(file_type) = info.file_type else {
		return Ok(Completion::Complete);
	};
	let full = opts.detail == Detail::Full;
	let root_entry = TreeEntry {
		path: b"",
		abs: root,
		file_type,
		depth: 0,
		size: (full && file_type == FileType::File).then_some(info.size),
		mtime: full.then_some(info.stamp.mtime),
	};
	let emit_root = opts.emit_root && opts.min_depth == 0;
	if emit_root && !opts.contents_first {
		match visit(Event::Entry(root_entry)) {
			Action::Stop => return Ok(Completion::Stopped),
			Action::SkipDir => return Ok(Completion::Complete),
			Action::Continue | Action::Skip => {},
		}
	}
	if file_type == FileType::Dir && opts.max_depth != Some(0) {
		let mut walker = Walker {
			fs,
			opts,
			stop,
			session,
			root,
			ignorer: None,
			root_dev: None,
			ancestors: Vec::new(),
			pool: Vec::new(),
			ign: Vec::new(),
			rel: Vec::new(),
			abs: root.as_os_str().as_encoded_bytes().to_vec(),
			open_dirs: 0,
			visited: 0,
		};
		if walker.walk(visit)? == Completion::Stopped {
			return Ok(Completion::Stopped);
		}
	}
	if emit_root && opts.contents_first && visit(Event::Entry(root_entry)) == Action::Stop {
		return Ok(Completion::Stopped);
	}
	Ok(Completion::Complete)
}

/// A contents-first report owed once a directory's contents are done.
#[derive(Clone, Copy)]
struct Post {
	file_type: FileType,
	depth:     usize,
	size:      Option<u64>,
	mtime:     Option<i64>,
}

/// A listed directory on the traversal stack.
struct Frame {
	listing:  Listing,
	/// Next record of `listing` to visit.
	next:     usize,
	/// Depth of this directory; its entries sit one level deeper.
	depth:    usize,
	ignore:   Option<Arc<IgnoreFrame>>,
	/// The open directory, for relative child opens (`None` past
	/// [`MAX_OPEN_DIRS`]).
	dir:      Option<Dir>,
	/// Path lengths to restore once the directory is done.
	rel_len:  usize,
	abs_len:  usize,
	post:     Option<Post>,
	/// Opening this directory pushed an ancestor identity.
	ancestor: bool,
}

/// The directories being listed, deepest last. Dropped deepest first, so
/// no frame releases a long ignore chain while ancestors still hold it.
struct Stack(Vec<Frame>);

impl Drop for Stack {
	fn drop(&mut self) {
		while self.0.pop().is_some() {}
	}
}

/// What to do after one entry.
enum Step {
	Next,
	Stop,
	/// Walk this directory next; the entry's path stays pushed.
	Push(Frame),
}

struct Walker<'a> {
	fs:        &'a Fs,
	opts:      &'a TreeOptions,
	stop:      &'a dyn Stop,
	session:   &'a mut Session,
	/// Absolute root.
	root:      &'a Path,
	ignorer:   Option<Ignorer>,
	root_dev:  Option<FileId>,
	/// Identities of the open directories under [`Follow::Always`].
	ancestors: Vec<FileId>,
	/// Recycled listings.
	pool:      Vec<Listing>,
	ign:       Vec<u8>,
	/// Walk-relative path of the current entry.
	rel:       Vec<u8>,
	/// Absolute path of the current entry (encoded `OsStr` bytes).
	abs:       Vec<u8>,
	open_dirs: usize,
	visited:   usize,
}

/// `bytes` (built from encoded `OsStr` pieces) as a path.
fn as_path(bytes: &[u8]) -> &Path {
	// SAFETY: every byte string passed here concatenates encoded `OsStr`
	// data, ASCII separators, and raw listed names.
	Path::new(unsafe { OsStr::from_encoded_bytes_unchecked(bytes) })
}

fn record_name<'n>(names: &'n [u8], record: &Record) -> &'n [u8] {
	let start = record.name_off as usize;
	&names[start..start + record.name_len as usize]
}

impl Walker<'_> {
	fn walk<V: FnMut(Event<'_>) -> Action>(
		&mut self,
		visit: &mut V,
	) -> Result<Completion, WalkError> {
		if self.opts.same_file_system {
			self.root_dev = self.session.identify(self.root).ok();
		}
		let inherited = if self.opts.gitignore {
			let (ignorer, frame) = Ignorer::new(self.session, self.fs, self.root);
			self.ignorer = Some(ignorer);
			frame
		} else {
			None
		};
		let saved = (0, self.abs.len());
		let opened = self
			.session
			.open_dir(self.root)
			.and_then(|dir| self.open_frame(dir, 0, inherited.as_ref(), 0, None, saved));
		let mut stack = Stack(Vec::new());
		match opened {
			Ok(frame) => stack.0.push(frame),
			Err(error) => {
				return Ok(match self.report(visit, error) {
					Step::Stop => Completion::Stopped,
					Step::Next | Step::Push(_) => Completion::Complete,
				});
			},
		}
		while let Some(frame) = stack.0.last_mut() {
			if frame.next == frame.listing.len() {
				let frame = stack.0.pop().expect("the loop holds a frame");
				if self.close(frame, visit) {
					return Ok(Completion::Stopped);
				}
				continue;
			}
			let index = frame.next;
			frame.next += 1;
			self.visited += 1;
			if self.visited.is_multiple_of(STOP_INTERVAL) && self.stop.stop() {
				return Err(WalkError::Stopped);
			}
			let parent = stack.0.last().expect("the loop holds a frame");
			match self.enter(parent, index, visit)? {
				Step::Next => {},
				Step::Stop => return Ok(Completion::Stopped),
				Step::Push(frame) => stack.0.push(frame),
			}
		}
		Ok(Completion::Complete)
	}

	/// Visits the `index`th entry of `parent`.
	fn enter<V: FnMut(Event<'_>) -> Action>(
		&mut self,
		parent: &Frame,
		index: usize,
		visit: &mut V,
	) -> Result<Step, WalkError> {
		let record = parent.listing.records()[index];
		let name = parent.listing.name(&record);
		let opts = self.opts;
		if pruned(name, opts.hidden, opts.skip_git, opts.skip_node_modules) {
			return Ok(Step::Next);
		}
		let saved = (self.rel.len(), self.abs.len());
		self.push_name(name);
		let step = self.enter_pushed(parent, record, name, saved, visit);
		if !matches!(step, Ok(Step::Push(_))) {
			self.rel.truncate(saved.0);
			self.abs.truncate(saved.1);
		}
		step
	}

	fn enter_pushed<V: FnMut(Event<'_>) -> Action>(
		&mut self,
		parent: &Frame,
		record: Record,
		name: &[u8],
		saved: (usize, usize),
		visit: &mut V,
	) -> Result<Step, WalkError> {
		let opts = self.opts;
		let depth = parent.depth + 1;
		let (mut file_type, mut size, mut mtime) = (record.file_type, record.size, record.mtime);
		let followed = file_type == FileType::Symlink && opts.follow == Follow::Always;
		if followed {
			match self.session.stat(as_path(&self.abs), true) {
				Err(error) => return Ok(self.report(visit, error)),
				Ok(info) => {
					let Some(target) = info.file_type else {
						return Ok(Step::Next);
					};
					file_type = target;
					if self.detail(parent.depth) == Detail::Full {
						size = (target == FileType::File).then_some(info.size);
						mtime = Some(info.stamp.mtime);
					}
				},
			}
		}
		let is_dir = file_type == FileType::Dir;
		if let Some(ignorer) = &self.ignorer {
			let exempt = matches!(file_type, FileType::File | FileType::Symlink)
				&& opts
					.unignored_name
					.is_some_and(|unignored| unignored.as_bytes() == name);
			if !exempt && ignorer.ignored(parent.ignore.as_deref(), &self.rel, is_dir, &mut self.ign) {
				return Ok(Step::Next);
			}
		}
		let mut target = None;
		if followed && is_dir {
			match self.session.identify(as_path(&self.abs)) {
				Err(error) => return Ok(self.report(visit, error)),
				Ok(id) if self.ancestors.contains(&id) => {
					return Ok(self.report(visit, io::Error::other("filesystem loop detected")));
				},
				Ok(id) => target = Some(id),
			}
		}
		let reported = depth >= opts.min_depth;
		let mut action = Action::Continue;
		if reported && !opts.contents_first {
			action = visit(Event::Entry(self.entry(file_type, depth, size, mtime)));
			if action == Action::Stop {
				return Ok(Step::Stop);
			}
		}
		let post =
			(reported && opts.contents_first).then_some(Post { file_type, depth, size, mtime });
		if is_dir && action != Action::SkipDir && opts.max_depth.is_none_or(|max| depth < max) {
			if self.stop.stop() {
				return Err(WalkError::Stopped);
			}
			let opened = match (&parent.dir, followed) {
				(Some(dir), false) => self.session.open_child(dir, name),
				_ => self.session.open_dir(as_path(&self.abs)),
			};
			let listed = opened.and_then(|dir| {
				if let Some(root) = self.root_dev {
					let id = match target {
						Some(id) => Some(id),
						None => self.session.identify_dir(&dir).ok(),
					};
					if !id.is_some_and(|id| id.dev == root.dev && id.native == root.native) {
						return Ok(None);
					}
				}
				self
					.open_frame(dir, depth, parent.ignore.as_ref(), record.children, post, saved)
					.map(Some)
			});
			match listed {
				Ok(Some(frame)) => return Ok(Step::Push(frame)),
				Ok(None) => {},
				Err(error) => {
					if matches!(self.report(visit, error), Step::Stop) {
						return Ok(Step::Stop);
					}
				},
			}
		}
		if let Some(post) = post
			&& visit(Event::Entry(self.entry(post.file_type, post.depth, post.size, post.mtime)))
				== Action::Stop
		{
			return Ok(Step::Stop);
		}
		Ok(Step::Next)
	}

	/// Lists the open `dir` at `depth` into a new frame.
	fn open_frame(
		&mut self,
		dir: Dir,
		depth: usize,
		parent_ignore: Option<&Arc<IgnoreFrame>>,
		children: u32,
		post: Option<Post>,
		saved: (usize, usize),
	) -> io::Result<Frame> {
		let mut listing = self.pool.pop().unwrap_or_default();
		let detail = self.detail(depth);
		if let Err(error) = self.session.list_into(&dir, detail, children, &mut listing) {
			self.pool.push(listing);
			return Err(error);
		}
		let Listing { records, names } = &mut listing;
		let names = names.as_slice();
		match self.opts.order {
			Order::Listing => {},
			Order::Names => {
				records.sort_unstable_by(|a, b| record_name(names, a).cmp(record_name(names, b)));
			},
			Order::Paths => {
				let key = |record: &Record| {
					let slash = (record.file_type == FileType::Dir).then_some(&b'/');
					record_name(names, record).iter().chain(slash)
				};
				records.sort_unstable_by(|a, b| key(a).cmp(key(b)));
			},
		}
		let ignore = if self.ignorer.is_some() {
			let mut names = Names::default();
			for record in listing.records() {
				names.record(listing.name(record), record.file_type);
			}
			if names.is_empty() {
				parent_ignore.cloned()
			} else {
				DirIgnores::load(self.session, &dir, names, false).frame(
					parent_ignore,
					names,
					&self.rel,
				)
			}
		} else {
			None
		};
		let ancestor = if self.opts.follow == Follow::Always
			&& let Ok(id) = self.session.identify_dir(&dir)
		{
			self.ancestors.push(id);
			true
		} else {
			false
		};
		let dir = (self.open_dirs < MAX_OPEN_DIRS).then_some(dir);
		self.open_dirs += usize::from(dir.is_some());
		Ok(Frame {
			listing,
			next: 0,
			depth,
			ignore,
			dir,
			rel_len: saved.0,
			abs_len: saved.1,
			post,
			ancestor,
		})
	}

	/// Finishes a fully walked directory; true when the visitor stopped.
	fn close<V: FnMut(Event<'_>) -> Action>(&mut self, frame: Frame, visit: &mut V) -> bool {
		let Frame { listing, dir, post, ancestor, rel_len, abs_len, .. } = frame;
		self.pool.push(listing);
		if dir.is_some() {
			self.open_dirs -= 1;
		}
		drop(dir);
		if ancestor {
			self.ancestors.pop();
		}
		let stopped = post.is_some_and(|post| {
			visit(Event::Entry(self.entry(post.file_type, post.depth, post.size, post.mtime)))
				== Action::Stop
		});
		self.rel.truncate(rel_len);
		self.abs.truncate(abs_len);
		stopped
	}

	/// Reports a failure at the current path.
	fn report<V: FnMut(Event<'_>) -> Action>(&self, visit: &mut V, error: io::Error) -> Step {
		let error = DirError { path: as_path(&self.abs).to_path_buf(), error };
		if visit(Event::Error(&error)) == Action::Stop {
			Step::Stop
		} else {
			Step::Next
		}
	}

	fn entry(
		&self,
		file_type: FileType,
		depth: usize,
		size: Option<u64>,
		mtime: Option<i64>,
	) -> TreeEntry<'_> {
		TreeEntry { path: &self.rel, abs: as_path(&self.abs), file_type, depth, size, mtime }
	}

	/// Listing detail for a directory at `depth`.
	fn detail(&self, depth: usize) -> Detail {
		if self.opts.detail_max_depth.is_some_and(|max| depth >= max) {
			Detail::Minimal
		} else {
			self.opts.detail
		}
	}

	/// Appends the child `name` to the current paths.
	fn push_name(&mut self, name: &[u8]) {
		if !self.rel.is_empty() {
			self.rel.push(b'/');
		}
		self.rel.extend_from_slice(name);
		if self.fs.is_native() {
			if !self.abs.last().is_some_and(|&byte| is_separator(byte)) {
				self.abs.push(SEP);
			}
			self.abs.extend_from_slice(name);
		} else {
			// URL children append one percent-encoded segment, keeping the
			// parent spelling as a prefix.
			self.abs = self
				.fs
				.join(as_path(&self.abs), name)
				.into_os_string()
				.into_encoded_bytes();
		}
	}
}
