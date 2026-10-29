//! The work-stealing engine behind [`super::walk`] and [`super::collect`].
//!
//! Worker 0 is the calling thread; helpers start once a worker holds more
//! than one pending directory. Each worker pops its own stack (depth first,
//! LIFO) and, while others idle, shares its oldest (shallowest, largest)
//! jobs through one shared stack. Idle workers spin briefly before sleeping:
//! a directory takes microseconds, so sleeping at once would make thread
//! wake-up latency the bottleneck. A pending-job counter ends the walk.

use std::{
	cmp::Ordering as CmpOrdering,
	io,
	marker::PhantomData,
	path::{Path, PathBuf},
	sync::{
		Arc, OnceLock,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use parking_lot::{Condvar, Mutex};

use super::{
	Action, DirError, Entry, Options, Stop, WalkError, Worker, absolute_root,
	arena::{Arena, Bytes},
	cache::Cache,
	give_session, join_child_into, join_into, pruned, take_session,
};
use crate::{
	fs::{Detail, Dir, FileId, FileInfo, FileType, Fs, Listing, Session},
	ignore::{DirIgnores, Frame, Ignorer, Names},
};

/// Directory handles kept open so pending children can open relative to
/// them; past the cap, children open by absolute path.
const MAX_RETAINED_DIRS: usize = 1024;

/// Polls of the shared stack (yielding in between) before an idle worker
/// sleeps.
const TAKE_SPINS: usize = 128;

/// What a walk does with entries: [`super::walk`] visits, [`super::collect`]
/// filters and keeps.
pub(super) trait Sink: Sync {
	/// Per-worker state.
	type Local: Send;
	/// Kept entries are stored, so every entry path goes to the arena.
	const COLLECTS: bool;

	fn init(&self) -> Self::Local;

	fn visit(
		&self,
		local: &mut Self::Local,
		worker: &mut Worker<'_>,
		entry: &mut Entry<'_>,
	) -> Action;
}

/// [`Sink`] of [`super::walk`].
pub(super) struct WalkSink<S, I, V> {
	init:   I,
	visit:  V,
	_state: PhantomData<fn() -> S>,
}

impl<S, I, V> WalkSink<S, I, V> {
	pub(super) const fn new(init: I, visit: V) -> Self {
		Self { init, visit, _state: PhantomData }
	}
}

impl<S, I, V> Sink for WalkSink<S, I, V>
where
	S: Send,
	I: Fn() -> S + Sync,
	V: Fn(&mut S, &mut Worker<'_>, &Entry<'_>) -> Action + Sync,
{
	type Local = S;

	const COLLECTS: bool = false;

	fn init(&self) -> S {
		(self.init)()
	}

	fn visit(&self, local: &mut S, worker: &mut Worker<'_>, entry: &mut Entry<'_>) -> Action {
		(self.visit)(local, worker, &*entry)
	}
}

/// [`Sink`] of [`super::collect`].
pub(super) struct CollectSink<F> {
	filter: F,
}

impl<F> CollectSink<F> {
	pub(super) const fn new(filter: F) -> Self {
		Self { filter }
	}
}

impl<F> Sink for CollectSink<F>
where
	F: Fn(&mut Worker<'_>, &mut Entry<'_>) -> Action + Sync,
{
	type Local = ();

	const COLLECTS: bool = true;

	fn init(&self) {}

	fn visit(&self, _local: &mut (), worker: &mut Worker<'_>, entry: &mut Entry<'_>) -> Action {
		(self.filter)(worker, entry)
	}
}

/// A collected entry whose path lives in a worker arena.
#[derive(Clone, Copy, Debug)]
pub(super) struct Stored {
	pub(super) path:      Bytes,
	pub(super) file_type: FileType,
	pub(super) depth:     usize,
	pub(super) size:      Option<u64>,
	pub(super) mtime:     Option<i64>,
}

/// One directory's share of a sorted collection, set once by the worker that
/// lists it.
type Slot = OnceLock<Vec<Item>>;

/// An entry (key `name`) or a subtree (key `name/`) of one directory.
/// Sorting these keys orders the directory's part of the output exactly as
/// sorting full paths would: a sibling such as `a-b` lands between directory
/// `a` and its contents `a/…` because `-` < `/`.
struct Item {
	name: Bytes,
	kind: ItemKind,
}

enum ItemKind {
	Entry(Stored),
	Dir(Arc<Slot>),
}

fn compare_items(a: &Item, b: &Item) -> CmpOrdering {
	// SAFETY: item names live in worker arenas that outlive the walk.
	let (an, bn) = unsafe { (a.name.get(), b.name.get()) };
	let n = an.len().min(bn.len());
	match an[..n].cmp(&bn[..n]) {
		CmpOrdering::Equal => {},
		other => return other,
	}
	// One name is a prefix of the other; compare the next key byte, where a
	// subtree key continues with '/' and an entry key ends.
	let next = |name: &[u8], item: &Item| -> i32 {
		if name.len() > n {
			i32::from(name[n])
		} else if matches!(item.kind, ItemKind::Dir(_)) {
			i32::from(b'/')
		} else {
			-1
		}
	};
	next(an, a).cmp(&next(bn, b))
}

/// Appends the entries of the sorted tree below `root` in order.
fn flatten(root: &Slot, out: &mut Vec<Stored>) {
	let mut stack = Vec::new();
	if let Some(items) = root.get() {
		stack.push(items.iter());
	}
	while let Some(top) = stack.last_mut() {
		let Some(item) = top.next() else {
			stack.pop();
			continue;
		};
		match &item.kind {
			ItemKind::Entry(entry) => out.push(*entry),
			ItemKind::Dir(slot) => {
				if let Some(items) = slot.get() {
					stack.push(items.iter());
				}
			},
		}
	}
}

/// A directory handle shared by the jobs of its subdirectories; closed when
/// the last of them has opened its own handle.
struct DirRef<'a> {
	dir:      Dir,
	retained: &'a AtomicUsize,
}

impl Drop for DirRef<'_> {
	fn drop(&mut self) {
		self.retained.fetch_sub(1, Ordering::Relaxed);
	}
}

/// A directory waiting to be listed.
struct Job<'a> {
	/// Open parent to resolve the name against; `None` opens by path.
	parent:   Option<Arc<DirRef<'a>>>,
	/// Walk-relative path; empty for the root.
	rel:      Bytes,
	/// Length of the final component of `rel`.
	name_len: usize,
	/// The root is 0.
	depth:    usize,
	/// Child count from the parent's listing, 0 if unknown.
	count:    u32,
	frame:    Option<Arc<Frame>>,
	/// Sorted-collection slot.
	out:      Option<Arc<Slot>>,
}

struct Queue<'a> {
	jobs:     Vec<Job<'a>>,
	sleeping: usize,
	done:     bool,
}

/// State shared by one walk's workers.
struct Ctx<'a> {
	fs:       &'a Fs,
	/// Absolute root.
	root:     &'a Path,
	opts:     &'a Options,
	stop:     &'a dyn Stop,
	ignorer:  Option<Ignorer>,
	cache:    Option<&'a Cache>,
	/// Device of the root under `same_file_system`.
	root_dev: Option<FileId>,
	retained: &'a AtomicUsize,
	queue:    Mutex<Queue<'a>>,
	cond:     Condvar,
	/// Jobs in `queue`, for lock-free polling.
	queued:   AtomicUsize,
	/// `queue.done`, for lock-free polling.
	finished: AtomicBool,
	/// Workers waiting in `take`.
	idle:     AtomicUsize,
	/// Jobs created and not yet finished.
	pending:  AtomicUsize,
	/// No more directories are listed.
	halt:     AtomicBool,
	/// [`Stop`] fired.
	stopped:  AtomicBool,
	/// Collected entries.
	total:    AtomicUsize,
}

impl<'a> Ctx<'a> {
	/// A shared job, or `None` once the walk is done.
	fn take(&self) -> Option<Job<'a>> {
		self.idle.fetch_add(1, Ordering::SeqCst);
		let job = self.take_inner();
		self.idle.fetch_sub(1, Ordering::SeqCst);
		job
	}

	fn take_inner(&self) -> Option<Job<'a>> {
		for _ in 0..TAKE_SPINS {
			if self.queued.load(Ordering::Acquire) > 0 || self.finished.load(Ordering::Acquire) {
				let mut queue = self.queue.lock();
				if let Some(job) = self.pop(&mut queue) {
					return Some(job);
				}
				if queue.done {
					return None;
				}
			}
			std::thread::yield_now();
		}
		let mut queue = self.queue.lock();
		loop {
			if let Some(job) = self.pop(&mut queue) {
				return Some(job);
			}
			if queue.done {
				return None;
			}
			queue.sleeping += 1;
			self.cond.wait(&mut queue);
			queue.sleeping -= 1;
		}
	}

	fn pop(&self, queue: &mut Queue<'a>) -> Option<Job<'a>> {
		let job = queue.jobs.pop()?;
		self.queued.fetch_sub(1, Ordering::Release);
		Some(job)
	}

	/// Moves jobs to the shared stack for idle workers.
	fn share(&self, jobs: impl Iterator<Item = Job<'a>>) {
		let mut queue = self.queue.lock();
		let before = queue.jobs.len();
		queue.jobs.extend(jobs);
		let added = queue.jobs.len() - before;
		self.queued.fetch_add(added, Ordering::Release);
		let wake = added.min(queue.sleeping);
		drop(queue);
		for _ in 0..wake {
			self.cond.notify_one();
		}
	}

	/// Marks one job finished, ending the walk after the last.
	fn finish(&self) {
		if self.pending.fetch_sub(1, Ordering::AcqRel) == 1 {
			let mut queue = self.queue.lock();
			queue.done = true;
			self.finished.store(true, Ordering::Release);
			drop(queue);
			self.cond.notify_all();
		}
	}
}

/// One worker's scratch.
struct Scratch<'a> {
	session: Session,
	/// Absolute path scratch (cache keys, opens by path, [`Worker::abs`]).
	abs:     PathBuf,
	/// Volatile path of a visited entry that is not retained.
	rel:     Vec<u8>,
	/// Ignore-matching scratch.
	ign:     Vec<u8>,
	/// Ignore-source paths for cache revalidation.
	probe:   Vec<u8>,
	listing: Listing,
	arena:   Arena,
	/// LIFO: depth first locally, oldest shared.
	local:   Vec<Job<'a>>,
	/// Unordered collection.
	out:     Vec<Stored>,
	errors:  Vec<DirError>,
}

impl Scratch<'_> {
	fn new(fs: &Fs) -> Self {
		Self {
			session: take_session(fs),
			abs:     PathBuf::new(),
			rel:     Vec::new(),
			ign:     Vec::new(),
			probe:   Vec::new(),
			listing: Listing::default(),
			arena:   Arena::default(),
			local:   Vec::new(),
			out:     Vec::new(),
			errors:  Vec::new(),
		}
	}
}

/// What a helper thread hands back.
struct Helper<L> {
	state:  L,
	arena:  Arena,
	out:    Vec<Stored>,
	errors: Vec<DirError>,
}

/// Results of [`run`].
pub(super) struct Outcome<L> {
	pub(super) states:  Vec<L>,
	/// Kept entries (collecting sinks only).
	pub(super) entries: Vec<Stored>,
	/// Owners of every `entries` path.
	pub(super) arenas:  Vec<Arena>,
	pub(super) errors:  Vec<DirError>,
}

/// Walks `root` with `sink`; `sorted` orders a collection by path.
pub(super) fn run<K: Sink>(
	fs: &Fs,
	root: &Path,
	opts: &Options,
	stop: &dyn Stop,
	sink: &K,
	sorted: bool,
	cache: Option<&Cache>,
) -> Result<Outcome<K::Local>, WalkError> {
	let retained = AtomicUsize::new(0);
	let abs_root = absolute_root(fs, root);
	let root_error = |error| WalkError::Root { path: root.to_path_buf(), error };
	if stop.stop() {
		return Err(WalkError::Stopped);
	}
	let workers = opts.parallelism(fs);
	let mut st = Scratch::new(fs);
	let root_dir = st.session.open_dir(&abs_root).map_err(root_error)?;
	let cache =
		cache.filter(|_| opts.detail == Detail::Minimal && fs.is_native() && !opts.same_file_system);
	let (ignorer, root_frame) = if opts.gitignore {
		let (ignorer, frame) = Ignorer::new(&mut st.session, fs, &abs_root);
		(Some(ignorer), frame)
	} else {
		(None, None)
	};
	let root_dev = if opts.same_file_system {
		st.session.identify_dir(&root_dir).ok()
	} else {
		None
	};
	let ctx = Ctx {
		fs,
		root: &abs_root,
		opts,
		stop,
		ignorer,
		cache,
		root_dev,
		retained: &retained,
		queue: Mutex::new(Queue { jobs: Vec::new(), sleeping: 0, done: false }),
		cond: Condvar::new(),
		queued: AtomicUsize::new(0),
		finished: AtomicBool::new(false),
		idle: AtomicUsize::new(0),
		pending: AtomicUsize::new(1),
		halt: AtomicBool::new(false),
		stopped: AtomicBool::new(false),
		total: AtomicUsize::new(0),
	};
	let root_slot = sorted.then(|| Arc::new(Slot::new()));
	let root_job = Job {
		parent:   None,
		rel:      Bytes::EMPTY,
		name_len: 0,
		depth:    0,
		count:    0,
		frame:    root_frame,
		out:      root_slot.clone(),
	};
	let mut local0 = sink.init();
	list_dir(&ctx, sink, 0, &mut st, &mut local0, root_job, Some(root_dir)).map_err(root_error)?;
	ctx.finish();

	let mut helpers = Vec::new();
	if !st.local.is_empty() {
		std::thread::scope(|scope| {
			let ctx = &ctx;
			let mut handles = Vec::new();
			let mut spawn = || {
				for id in 1..workers {
					handles.push(scope.spawn(move || helper(ctx, sink, id)));
				}
			};
			let spawn = (workers > 1).then_some(&mut spawn as &mut dyn FnMut());
			worker_loop(ctx, sink, 0, &mut st, &mut local0, spawn);
			for handle in handles {
				match handle.join() {
					Ok(out) => helpers.push(out),
					Err(panic) => std::panic::resume_unwind(panic),
				}
			}
		});
	}
	let stopped = ctx.stopped.load(Ordering::Relaxed);
	let total = ctx.total.load(Ordering::Relaxed);
	drop(ctx);
	let Scratch { session, arena, out, errors, .. } = st;
	give_session(fs, session);
	if stopped {
		return Err(WalkError::Stopped);
	}
	let mut outcome = Outcome { states: vec![local0], entries: out, arenas: vec![arena], errors };
	if let Some(slot) = &root_slot {
		outcome.entries = Vec::with_capacity(total);
		flatten(slot, &mut outcome.entries);
	} else {
		outcome
			.entries
			.reserve(total.saturating_sub(outcome.entries.len()));
	}
	for helper in helpers {
		outcome.states.push(helper.state);
		outcome.arenas.push(helper.arena);
		if root_slot.is_none() {
			outcome.entries.extend(helper.out);
		}
		outcome.errors.extend(helper.errors);
	}
	Ok(outcome)
}

fn helper<K: Sink>(ctx: &Ctx<'_>, sink: &K, id: usize) -> Helper<K::Local> {
	let mut st = Scratch::new(ctx.fs);
	let mut state = sink.init();
	worker_loop(ctx, sink, id, &mut st, &mut state, None);
	let Scratch { session, arena, out, errors, .. } = st;
	give_session(ctx.fs, session);
	Helper { state, arena, out, errors }
}

fn worker_loop<'a, K: Sink>(
	ctx: &Ctx<'a>,
	sink: &K,
	id: usize,
	st: &mut Scratch<'a>,
	local: &mut K::Local,
	mut spawn: Option<&mut dyn FnMut()>,
) {
	let _guard = EndOnPanic(ctx);
	loop {
		if st.local.len() > 1
			&& let Some(spawn) = spawn.take()
		{
			spawn();
			let give = st.local.len() / 2;
			ctx.share(st.local.drain(..give));
		}
		let job = match st.local.pop() {
			Some(job) => job,
			None => match ctx.take() {
				Some(job) => job,
				None => return,
			},
		};
		process(ctx, sink, id, st, local, job);
		let queued = st.local.len();
		if queued > 1 {
			let idle = ctx.idle.load(Ordering::Relaxed);
			if idle > 0 {
				// Share the oldest (shallowest, largest) jobs: at least half,
				// or one per idle worker while keeping one.
				let give = (queued / 2).max(idle.min(queued - 1));
				ctx.share(st.local.drain(..give));
			}
		}
		ctx.finish();
	}
}

/// Ends the walk when a worker's visitor panics, so the other workers stop
/// waiting for jobs that will never finish; the scope re-raises the panic.
struct EndOnPanic<'c, 'a>(&'c Ctx<'a>);

impl Drop for EndOnPanic<'_, '_> {
	fn drop(&mut self) {
		if std::thread::panicking() {
			let ctx = self.0;
			ctx.halt.store(true, Ordering::Relaxed);
			let mut queue = ctx.queue.lock();
			queue.done = true;
			ctx.finished.store(true, Ordering::Release);
			drop(queue);
			ctx.cond.notify_all();
		}
	}
}

fn process<'a, K: Sink>(
	ctx: &Ctx<'a>,
	sink: &K,
	id: usize,
	st: &mut Scratch<'a>,
	local: &mut K::Local,
	job: Job<'a>,
) {
	if ctx.halt.load(Ordering::Relaxed) {
		return;
	}
	if ctx.stop.stop() {
		ctx.stopped.store(true, Ordering::Relaxed);
		ctx.halt.store(true, Ordering::Relaxed);
		return;
	}
	let rel = job.rel;
	if let Err(error) = list_dir(ctx, sink, id, st, local, job, None) {
		// SAFETY: job paths live in worker arenas that outlive the walk.
		let path = ctx.fs.join(ctx.root, unsafe { rel.get() });
		st.errors.push(DirError { path, error });
	}
}

/// Lists the directory of `job` (already `opened` for the root) and emits
/// it. Errors are open and listing failures.
fn list_dir<'a, K: Sink>(
	ctx: &Ctx<'a>,
	sink: &K,
	id: usize,
	st: &mut Scratch<'a>,
	local: &mut K::Local,
	job: Job<'a>,
	opened: Option<Dir>,
) -> io::Result<()> {
	let Job { parent, rel: rel_bytes, name_len, depth, count, frame, out } = job;
	// SAFETY: job paths live in worker arenas that outlive the walk.
	let rel = unsafe { rel_bytes.get() };
	let dir_job = DirJob { rel: rel_bytes, depth, out };
	if let Some(cache) = ctx.cache {
		join_into(ctx.fs, ctx.root, rel, &mut st.abs);
		if let Some(cached) =
			cache.lookup(&mut st.session, &st.abs, ctx.ignorer.is_some(), &mut st.probe)
		{
			drop(parent);
			drop(opened);
			let frame = match &cached.ignores {
				Some(ignores) if ctx.ignorer.is_some() => {
					ignores.frame(frame.as_ref(), cached.names, rel)
				},
				_ => frame,
			};
			emit(ctx, sink, id, st, local, dir_job, &cached.listing, frame.as_ref(), None);
			return Ok(());
		}
	}

	let dir = match (opened, parent) {
		(Some(dir), _) => dir,
		(None, Some(parent)) => {
			let opened = st
				.session
				.open_child(&parent.dir, &rel[rel.len() - name_len..]);
			drop(parent);
			opened?
		},
		(None, None) => {
			join_into(ctx.fs, ctx.root, rel, &mut st.abs);
			st.session.open_dir(&st.abs)?
		},
	};
	if depth > 0
		&& let Some(root_dev) = ctx.root_dev
	{
		match st.session.identify_dir(&dir) {
			Ok(id) if id.dev == root_dev.dev && id.native == root_dev.native => {},
			_ => return Ok(()),
		}
	}
	// Stamp before listing: any later change moves the stamp on.
	let stamp = if ctx.cache.is_some() {
		st.session.stat_dir(&dir).ok()
	} else {
		None
	};
	let mut listing = std::mem::take(&mut st.listing);
	if let Err(error) = st
		.session
		.list_into(&dir, ctx.opts.detail, count, &mut listing)
	{
		st.listing = listing;
		return Err(error);
	}
	let mut names = Names::default();
	if ctx.ignorer.is_some() || stamp.is_some() {
		for record in listing.records() {
			names.record(listing.name(record), record.file_type);
		}
	}
	let ignores = ctx.ignorer.as_ref().map(|_| {
		if names.is_empty() {
			DirIgnores::default()
		} else {
			DirIgnores::load(&mut st.session, &dir, names, stamp.is_some())
		}
	});
	let frame = match &ignores {
		Some(ignores) => ignores.frame(frame.as_ref(), names, rel),
		None => frame,
	};
	if let (Some(cache), Some(stamp)) = (ctx.cache, stamp) {
		join_into(ctx.fs, ctx.root, rel, &mut st.abs);
		cache.store(&mut st.session, &st.abs, &dir, stamp, &listing, names, ignores.as_ref());
	}
	ctx.retained.fetch_add(1, Ordering::Relaxed);
	let dir = Arc::new(DirRef { dir, retained: ctx.retained });
	emit(ctx, sink, id, st, local, dir_job, &listing, frame.as_ref(), Some(&dir));
	st.listing = listing;
	Ok(())
}

/// The parts of a job [`emit`] needs.
struct DirJob {
	rel:   Bytes,
	depth: usize,
	out:   Option<Arc<Slot>>,
}

/// Filters and delivers one directory's listing and queues its
/// subdirectories. With `dir`, children open relative to it and visitors
/// read files relative to it; cached listings pass `None`.
#[expect(clippy::too_many_arguments, reason = "one call per listing source")]
fn emit<'a, K: Sink>(
	ctx: &Ctx<'a>,
	sink: &K,
	id: usize,
	st: &mut Scratch<'a>,
	local: &mut K::Local,
	job: DirJob,
	listing: &Listing,
	frame: Option<&Arc<Frame>>,
	dir: Option<&Arc<DirRef<'a>>>,
) {
	let opts = ctx.opts;
	let depth = job.depth + 1;
	if opts.max_depth.is_some_and(|max| depth > max) {
		return;
	}
	let descend = opts.max_depth.is_none_or(|max| depth < max);
	// SAFETY: job paths live in worker arenas that outlive the walk.
	let rel = unsafe { job.rel.get() };
	let Scratch { session, abs, rel: volatile, ign, arena, local: jobs, out: unordered, .. } = st;
	let first_child = jobs.len();
	let mut items = Vec::new();
	if job.out.is_some() {
		items.reserve(listing.len());
	}
	let mut collected = 0usize;
	let mut share_parent: Option<bool> = None;
	let mut worker =
		Worker { id, fs: ctx.fs, root: ctx.root, session, abs, dir: dir.map(|dir| &dir.dir) };
	for record in listing.records() {
		let name = listing.name(record);
		if pruned(name, opts.hidden, opts.skip_git, opts.skip_node_modules) {
			continue;
		}
		let (mut file_type, mut size, mut mtime) = (record.file_type, record.size, record.mtime);
		if file_type == FileType::Symlink && opts.follow_links {
			let Some((target, info)) = follow(ctx, &mut worker, rel, name) else {
				continue;
			};
			file_type = target;
			size = (target == FileType::File).then_some(info.size);
			mtime = Some(info.stamp.mtime);
		}
		let is_dir = file_type == FileType::Dir;
		let kept = (K::COLLECTS || (is_dir && descend)).then(|| {
			if rel.is_empty() {
				arena.push(&[name])
			} else {
				arena.push(&[rel, b"/", name])
			}
		});
		let path: &[u8] = if let Some(bytes) = kept {
			// SAFETY: the arena outlives the walk.
			unsafe { bytes.get() }
		} else {
			volatile.clear();
			if !rel.is_empty() {
				volatile.extend_from_slice(rel);
				volatile.push(b'/');
			}
			volatile.extend_from_slice(name);
			volatile.as_slice()
		};
		if let Some(ignorer) = &ctx.ignorer
			&& ignorer.ignored(frame.map(|frame| &**frame), path, is_dir, ign)
		{
			continue;
		}
		let mut entry = Entry { path, file_type, depth, size, mtime };
		match sink.visit(local, &mut worker, &mut entry) {
			Action::Stop => {
				ctx.halt.store(true, Ordering::Relaxed);
				jobs.truncate(first_child);
				break;
			},
			Action::SkipDir => continue,
			Action::Skip => {},
			Action::Continue => {
				if K::COLLECTS
					&& let Some(bytes) = kept
				{
					let stored = Stored {
						path: bytes,
						file_type: entry.file_type,
						depth,
						size: entry.size,
						mtime: entry.mtime,
					};
					if job.out.is_some() {
						items.push(Item { name: bytes.tail(name.len()), kind: ItemKind::Entry(stored) });
					} else {
						unordered.push(stored);
					}
					collected += 1;
				}
			},
		}
		if !is_dir || !descend {
			continue;
		}
		let Some(bytes) = kept else { continue };
		// A linked directory opens by path: `open_child` refuses symlinks.
		let parent = match dir {
			Some(dir) if record.file_type != FileType::Symlink => {
				let share = *share_parent
					.get_or_insert_with(|| ctx.retained.load(Ordering::Relaxed) < MAX_RETAINED_DIRS);
				share.then(|| Arc::clone(dir))
			},
			_ => None,
		};
		let slot = job.out.as_ref().map(|_| {
			let slot = Arc::new(Slot::new());
			items.push(Item { name: bytes.tail(name.len()), kind: ItemKind::Dir(Arc::clone(&slot)) });
			slot
		});
		jobs.push(Job {
			parent,
			rel: bytes,
			name_len: name.len(),
			depth,
			count: record.children,
			frame: frame.cloned(),
			out: slot,
		});
	}
	if collected > 0 {
		ctx.total.fetch_add(collected, Ordering::Relaxed);
	}
	if let Some(out) = job.out {
		items.sort_unstable_by(compare_items);
		let _ = out.set(items);
	}
	let children = jobs.len() - first_child;
	if children > 0 {
		ctx.pending.fetch_add(children, Ordering::AcqRel);
		// Pop order is LIFO; reverse so the first child is walked first.
		jobs[first_child..].reverse();
	}
}

/// Resolves the symlink `name` in the walk-relative directory `dir` for
/// [`Options::follow_links`]: `None` for dangling links, links to special
/// files, and links to `dir` or one of its ancestors.
fn follow(
	ctx: &Ctx<'_>,
	worker: &mut Worker<'_>,
	dir: &[u8],
	name: &[u8],
) -> Option<(FileType, FileInfo)> {
	join_child_into(ctx.fs, ctx.root, dir, name, worker.abs);
	let info = worker.session.stat(worker.abs.as_path(), true).ok()?;
	match info.file_type? {
		FileType::File => Some((FileType::File, info)),
		FileType::Dir => {
			let target = worker.session.identify(worker.abs.as_path()).ok()?;
			// Cycles are rare and shallow: identify the enclosing directories
			// only when a linked directory needs checking.
			let mut up = dir;
			loop {
				join_into(ctx.fs, ctx.root, up, worker.abs);
				if worker
					.session
					.identify(worker.abs.as_path())
					.is_ok_and(|id| id == target)
				{
					return None;
				}
				if up.is_empty() {
					return Some((FileType::Dir, info));
				}
				up = &up[..memchr::memrchr(b'/', up).unwrap_or(0)];
			}
		},
		FileType::Symlink => None,
	}
}
