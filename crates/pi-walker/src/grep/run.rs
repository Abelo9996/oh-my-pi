//! [`super::grep`] orchestration: root classification, the file-root search,
//! the unbounded parallel walk, the budgeted ordered search, and pi's result
//! aggregation.

use std::{
	io,
	path::Path,
	sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

use grep_matcher::Matcher;

use super::{
	Engine, GrepError, GrepOptions, GrepResult, MAX_FILE_BYTES, Match, MatchSink, Mode,
	scan::{STREAM_LINE_LIMIT, ScanOutcome, ScanParams, Scanner, scan_reader},
	types::TypeFilter,
};
use crate::{
	exec::{self, Flow},
	fs::{Detail, File, FileType, Fs, Session},
	glob::Selector,
	walk::{self, Action, Completion, Event, Follow, Order, Stop, TreeOptions, WalkError, arena},
};

/// Largest batch handed to a [`MatchSink`].
const SINK_BATCH: usize = 1024;

/// Which entries a directory search reads.
struct PathFilter {
	scope:   Option<Selector>,
	exclude: Option<Selector>,
	types:   Option<TypeFilter>,
}

impl PathFilter {
	/// A directory is pruned when excluded or out of scope.
	fn prunes_dir(&self, path: &[u8]) -> bool {
		self.exclude.as_ref().is_some_and(|ex| ex.matches(path))
			|| self.scope.as_ref().is_some_and(|scope| scope.prunes(path))
	}

	/// Whether the regular file at `path` (named `name`) is searched.
	fn keeps_file(&self, path: &[u8], name: &[u8]) -> bool {
		self.types.as_ref().is_none_or(|types| types.matches(name))
			&& self.scope.as_ref().is_none_or(|scope| scope.matches(path))
			&& !self.exclude.as_ref().is_some_and(|ex| ex.matches(path))
	}
}

/// One search's shared, read-only state.
struct Search<'s, M> {
	matcher:   &'s M,
	multiline: bool,
	spans:     bool,
	mode:      Mode,
	params:    ScanParams,
}

/// A searched file with matches.
struct FileHit {
	path:          String,
	matches:       Vec<Match>,
	count:         u64,
	limit_reached: bool,
	oversized:     bool,
}

impl<M: Matcher> Search<'_, M> {
	/// Scans `buf`; a search error counts as a searched file without
	/// matches, as in pi.
	fn scan(&self, scanner: &mut Scanner, buf: &[u8], matches: &mut Vec<Match>) -> ScanOutcome {
		scanner
			.scan(self.matcher, self.multiline, self.spans, buf, &self.params, matches)
			.unwrap_or_else(|_| {
				matches.clear();
				ScanOutcome::default()
			})
	}

	/// A matching file's units toward a budget: collected matches
	/// (content), matches (count), or the file (files-with-matches).
	const fn units(&self, count: u64, collected: u64) -> u64 {
		match self.mode {
			Mode::Content => collected,
			Mode::Count => count,
			Mode::FilesWithMatches => 1,
		}
	}
}

/// Per-thread search scratch.
#[derive(Default)]
struct Scratch {
	scanner: Scanner,
	buf:     Vec<u8>,
}

/// Hands one file's results to `sink`: content matches in batches of at
/// most [`SINK_BATCH`], otherwise one entry.
fn deliver(
	sink: &dyn MatchSink,
	mode: Mode,
	path: &str,
	matches: Vec<Match>,
	count: u64,
) -> Result<(), String> {
	if mode != Mode::Content {
		return sink.deliver(vec![file_entry(mode, path.to_owned(), count)]);
	}
	let mut rest = matches.into_iter();
	loop {
		let batch: Vec<Match> = rest
			.by_ref()
			.take(SINK_BATCH)
			.map(|mut m| {
				path.clone_into(&mut m.path);
				m
			})
			.collect();
		if batch.is_empty() {
			return Ok(());
		}
		sink.deliver(batch)?;
	}
}

/// Appends `matches` to `out` with `path` attached (cloned for all but the
/// last).
fn attach(path: String, matches: impl Iterator<Item = Match>, out: &mut Vec<Match>) {
	let mut matches = matches.peekable();
	while let Some(mut m) = matches.next() {
		if matches.peek().is_none() {
			m.path = path;
			out.push(m);
			return;
		}
		m.path.clone_from(&path);
		out.push(m);
	}
}

/// The entry a matching file contributes outside content mode.
fn file_entry(mode: Mode, path: String, count: u64) -> Match {
	Match {
		path,
		line: 0,
		text: String::new(),
		before: Vec::new(),
		after: Vec::new(),
		truncated: false,
		column: None,
		count: (mode == Mode::Count).then_some(count),
	}
}

/// See [`super::grep`].
pub fn grep(
	fs: &Fs,
	root: &Path,
	opts: &GrepOptions<'_>,
	stop: &dyn Stop,
) -> Result<GrepResult, GrepError> {
	if opts.sink.is_some() && (opts.max_count.is_some() || opts.offset != 0) {
		return Err(GrepError::StreamLimits);
	}
	let glob = opts
		.glob
		.as_deref()
		.map(str::trim)
		.filter(|glob| !glob.is_empty());
	let filter = PathFilter {
		scope:   glob
			.map(|glob| Selector::scope(glob, opts.recursive))
			.transpose()
			.map_err(GrepError::Glob)?,
		exclude: Selector::exclude(&opts.exclude).map_err(GrepError::Exclude)?,
		types:   opts.file_type.as_deref().and_then(TypeFilter::new),
	};
	let mut session = fs.session();
	let file_type = session
		.stat(root, true)
		.map_err(GrepError::NotFound)?
		.file_type;
	let spans = opts.engine.spans_lines();
	match opts.engine {
		Engine::Rust(m) => run(m, spans, fs, root, file_type, session, opts, stop, &filter),
		Engine::Pcre(m) => run(m, spans, fs, root, file_type, session, opts, stop, &filter),
	}
}

#[allow(clippy::too_many_arguments, reason = "one dispatch point per engine")]
fn run<M: Matcher + Sync>(
	matcher: &M,
	spans: bool,
	fs: &Fs,
	root: &Path,
	file_type: Option<FileType>,
	session: Session,
	opts: &GrepOptions<'_>,
	stop: &dyn Stop,
	filter: &PathFilter,
) -> Result<GrepResult, GrepError> {
	let content = opts.mode == Mode::Content;
	let mut params = ScanParams {
		content,
		before: if content { opts.before } else { 0 },
		after: if content { opts.after } else { 0 },
		max_columns: opts.max_columns,
		offset: 0,
		cap: None,
		probe: true,
	};
	match file_type {
		Some(FileType::File) => {
			params.offset = opts.offset;
			params.cap = match opts.mode {
				Mode::Content => min_some(opts.max_count, opts.max_count_per_file),
				Mode::Count => None,
				Mode::FilesWithMatches => Some(1),
			};
			let search = Search { matcher, multiline: opts.multiline, spans, mode: opts.mode, params };
			file_root(&search, session, root, opts, stop, filter.types.as_ref())
		},
		Some(FileType::Dir) => {
			// Each file applies the offset fresh, so it widens the cap; files
			// mode needs only the first match.
			params.cap = match opts.mode {
				Mode::Content => min_some(
					opts.max_count.map(|max| max.saturating_add(opts.offset)),
					opts.max_count_per_file,
				),
				Mode::Count => None,
				Mode::FilesWithMatches => Some(1),
			};
			params.probe = opts.mode != Mode::FilesWithMatches;
			let search = Search { matcher, multiline: opts.multiline, spans, mode: opts.mode, params };
			let wopts = walk::Options {
				hidden: opts.walk.hidden,
				gitignore: opts.walk.gitignore,
				skip_git: true,
				skip_node_modules: !filter
					.scope
					.as_ref()
					.is_some_and(Selector::mentions_node_modules),
				follow_links: false,
				detail: Detail::Minimal,
				max_depth: filter.scope.as_ref().and_then(Selector::max_depth),
				workers: opts.walk.workers,
				cache: opts.walk.cache,
				..walk::Options::default()
			};
			drop(session);
			match opts.max_count {
				Some(max) if max > 0 => budgeted(&search, fs, root, &wopts, filter, opts, stop, max),
				_ => unbounded(&search, fs, root, &wopts, filter, opts, stop),
			}
		},
		_ => Ok(GrepResult::default()),
	}
}

/// The smaller of two optional caps.
fn min_some(a: Option<u64>, b: Option<u64>) -> Option<u64> {
	match (a, b) {
		(Some(a), Some(b)) => Some(a.min(b)),
		(a, b) => a.or(b),
	}
}

/// A read that fails once `stop` fires: streaming a large file can outlast
/// the caller's deadline.
struct StoppableReader<'a> {
	file: File,
	stop: &'a dyn Stop,
}

impl io::Read for StoppableReader<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if self.stop.stop() {
			return Err(io::Error::other("stopped"));
		}
		self.file.read(buf)
	}
}

/// What a file root is searched over.
enum Haystack {
	/// Its bytes (at most [`MAX_FILE_BYTES`]).
	Bytes,
	/// The open file, streamed in full.
	Stream(File),
}

fn file_root<M: Matcher>(
	search: &Search<'_, M>,
	mut session: Session,
	root: &Path,
	opts: &GrepOptions<'_>,
	stop: &dyn Stop,
	types: Option<&TypeFilter>,
) -> Result<GrepResult, GrepError> {
	if let Some(types) = types {
		let name = pi_vfs::file_name(root);
		if !name.is_some_and(|name| types.matches(name.as_encoded_bytes())) {
			return Ok(GrepResult::default());
		}
	}
	let skipped = GrepResult { skipped_oversized: 1, ..GrepResult::default() };
	let Ok((mut file, info)) = session.open_file(root) else {
		return Ok(GrepResult::default());
	};
	let mut buf = Vec::new();
	let haystack = if info.size > MAX_FILE_BYTES {
		if search.multiline {
			if file.read_into(&mut buf, MAX_FILE_BYTES).is_err() {
				return Ok(skipped);
			}
			Haystack::Bytes
		} else {
			Haystack::Stream(file)
		}
	} else {
		if file.read_into(&mut buf, MAX_FILE_BYTES + 1).is_err() {
			return Ok(GrepResult::default());
		}
		if buf.len() as u64 <= MAX_FILE_BYTES {
			Haystack::Bytes
		} else if search.multiline {
			buf.truncate(MAX_FILE_BYTES as usize);
			Haystack::Bytes
		} else {
			match session.open_file(root) {
				Ok((file, _)) => Haystack::Stream(file),
				Err(_) => return Ok(skipped),
			}
		}
	};
	drop(session);

	// One file either matches or not: report it once, as a directory walk
	// does.
	let fast = opts.mode == Mode::FilesWithMatches && opts.max_count.is_none() && opts.offset == 0;
	let params = if fast {
		ScanParams { cap: Some(1), probe: false, ..search.params }
	} else {
		search.params
	};
	let mut matches = Vec::new();
	let outcome = match haystack {
		Haystack::Bytes => Scanner::default()
			.scan(search.matcher, search.multiline, search.spans, &buf, &params, &mut matches)
			.map_err(|err| GrepError::Search(err.to_string()))?,
		Haystack::Stream(file) => {
			scan_reader(search.matcher, StoppableReader { file, stop }, &params, &mut matches)
				.map_err(|err| {
					if stop.stop() {
						GrepError::Walk(WalkError::Stopped)
					} else {
						GrepError::Search(format!(
							"{err} (a line longer than {} MiB cannot be searched; use read for this file)",
							STREAM_LINE_LIMIT / (1024 * 1024)
						))
					}
				})?
		},
	};
	if outcome.count == 0 {
		return Ok(GrepResult { files_searched: 1, ..GrepResult::default() });
	}
	let path = root.to_string_lossy().into_owned();
	let (total, limit_reached) = if fast {
		(1, false)
	} else {
		(
			outcome.count,
			outcome.limit_reached || opts.max_count.is_some_and(|max| outcome.collected >= max),
		)
	};
	let mut result = GrepResult {
		matches: Vec::new(),
		total_matches: total,
		files_with_matches: 1,
		files_searched: 1,
		limit_reached,
		skipped_oversized: 0,
	};
	if let Some(sink) = opts.sink {
		deliver(sink, opts.mode, &path, matches, outcome.count).map_err(GrepError::Sink)?;
		return Ok(result);
	}
	if opts.mode == Mode::Content {
		attach(path, matches.into_iter(), &mut result.matches);
	} else {
		result
			.matches
			.push(file_entry(opts.mode, path, outcome.count));
	}
	Ok(result)
}

/// One walk worker's share of an unbounded search.
#[derive(Default)]
struct WalkState {
	scratch:   Scratch,
	hits:      Vec<FileHit>,
	searched:  u64,
	oversized: u64,
	failure:   Option<String>,
}

/// Searches every candidate inside one parallel walk, opening files relative
/// to the directory the walk holds open; results merge into path order,
/// files over [`MAX_FILE_BYTES`] (searched over that prefix) last.
fn unbounded<M: Matcher + Sync>(
	search: &Search<'_, M>,
	fs: &Fs,
	root: &Path,
	wopts: &walk::Options,
	filter: &PathFilter,
	opts: &GrepOptions<'_>,
	stop: &dyn Stop,
) -> Result<GrepResult, GrepError> {
	let halt = AtomicBool::new(false);
	let stopped = AtomicBool::new(false);
	let streamed_matches = AtomicU64::new(0);
	let streamed_files = AtomicU64::new(0);
	let streamed_limit = AtomicBool::new(false);
	let walked = walk::walk(fs, root, wopts, stop, WalkState::default, |st, worker, entry| {
		if halt.load(Ordering::Relaxed) {
			return Action::Stop;
		}
		match entry.file_type {
			FileType::Dir => {
				return if filter.prunes_dir(entry.path) {
					Action::SkipDir
				} else {
					Action::Continue
				};
			},
			FileType::Symlink => return Action::Skip,
			FileType::File => {},
		}
		if !filter.keeps_file(entry.path, entry.name()) {
			return Action::Skip;
		}
		if stop.stop() {
			stopped.store(true, Ordering::Relaxed);
			halt.store(true, Ordering::Relaxed);
			return Action::Stop;
		}
		let Ok((mut file, info)) = worker.open_file(entry) else {
			return Action::Continue;
		};
		let mut oversized = info.size > MAX_FILE_BYTES;
		let limit = if oversized {
			MAX_FILE_BYTES
		} else {
			MAX_FILE_BYTES + 1
		};
		if file.read_into(&mut st.scratch.buf, limit).is_err() {
			st.oversized += u64::from(oversized);
			return Action::Continue;
		}
		drop(file);
		if st.scratch.buf.len() as u64 > MAX_FILE_BYTES {
			st.scratch.buf.truncate(MAX_FILE_BYTES as usize);
			oversized = true;
		}
		st.searched += 1;
		let mut matches = Vec::new();
		let outcome = search.scan(&mut st.scratch.scanner, &st.scratch.buf, &mut matches);
		if outcome.count == 0 {
			return Action::Continue;
		}
		if let Some(sink) = opts.sink {
			streamed_files.fetch_add(1, Ordering::Relaxed);
			streamed_matches.fetch_add(outcome.count, Ordering::Relaxed);
			if outcome.limit_reached {
				streamed_limit.store(true, Ordering::Relaxed);
			}
			if let Err(err) = deliver(sink, opts.mode, &entry.path_lossy(), matches, outcome.count) {
				st.failure = Some(err);
				halt.store(true, Ordering::Relaxed);
				return Action::Stop;
			}
			return Action::Continue;
		}
		st.hits.push(FileHit {
			path: entry.path_lossy().into_owned(),
			matches,
			count: outcome.count,
			limit_reached: outcome.limit_reached,
			oversized,
		});
		Action::Continue
	})
	.map_err(GrepError::Walk)?;

	let mut hits = Vec::new();
	let (mut searched, mut oversized) = (0, 0);
	for st in walked.states {
		if let Some(failure) = st.failure {
			return Err(GrepError::Sink(failure));
		}
		searched += st.searched;
		oversized += st.oversized;
		hits.extend(st.hits);
	}
	if stopped.load(Ordering::Relaxed) {
		return Err(GrepError::Walk(WalkError::Stopped));
	}
	if opts.sink.is_some() {
		return Ok(GrepResult {
			matches:            Vec::new(),
			total_matches:      streamed_matches.load(Ordering::Relaxed),
			files_with_matches: streamed_files.load(Ordering::Relaxed),
			files_searched:     searched,
			limit_reached:      streamed_limit.load(Ordering::Relaxed),
			skipped_oversized:  oversized,
		});
	}
	hits.sort_unstable_by(|a, b| (a.oversized, &a.path).cmp(&(b.oversized, &b.path)));
	Ok(aggregate(hits, opts, searched, oversized))
}

/// One candidate's outcome in a budgeted pass.
enum Outcome {
	/// Searched; matches when `Some`.
	Searched(Option<(FileHit, u64)>),
	/// Over [`MAX_FILE_BYTES`]: searched in the second pass.
	Defer,
	/// Unreadable.
	Skipped,
	/// Over [`MAX_FILE_BYTES`] and unreadable.
	SkippedOversized,
}

/// Searches the candidate at walk-relative `rel` for a budgeted pass: in full
/// (deferring files over [`MAX_FILE_BYTES`]) or, with `prefix`, over that
/// prefix.
fn search_candidate<M: Matcher>(
	search: &Search<'_, M>,
	fs: &Fs,
	root: &Path,
	(scratch, session): &mut (Scratch, Session),
	rel: &[u8],
	prefix: bool,
) -> Outcome {
	let unreadable = if prefix {
		Outcome::SkippedOversized
	} else {
		Outcome::Skipped
	};
	let Ok((mut file, info)) = session.open_file(&fs.join(root, rel)) else {
		return unreadable;
	};
	if !prefix && info.size > MAX_FILE_BYTES {
		return Outcome::Defer;
	}
	let limit = if prefix {
		MAX_FILE_BYTES
	} else {
		MAX_FILE_BYTES + 1
	};
	if file.read_into(&mut scratch.buf, limit).is_err() {
		return unreadable;
	}
	drop(file);
	if !prefix && scratch.buf.len() as u64 > MAX_FILE_BYTES {
		return Outcome::Defer;
	}
	let mut matches = Vec::new();
	let outcome = search.scan(&mut scratch.scanner, &scratch.buf, &mut matches);
	if outcome.count == 0 {
		return Outcome::Searched(None);
	}
	let hit = FileHit {
		path: String::from_utf8_lossy(rel).into_owned(),
		matches,
		count: outcome.count,
		limit_reached: outcome.limit_reached,
		oversized: prefix,
	};
	Outcome::Searched(Some((hit, outcome.collected)))
}

/// The settled prefix of a budgeted search.
struct Budget<'b, 's, M> {
	search:    &'b Search<'s, M>,
	need:      u64,
	units:     u64,
	settled:   bool,
	hits:      Vec<FileHit>,
	/// Oversized candidates (walk-relative paths) for the prefix pass.
	deferred:  Vec<arena::Bytes>,
	searched:  u64,
	oversized: u64,
}

impl<M: Matcher> Budget<'_, '_, M> {
	/// Takes the outcome of the candidate at `rel`, in path order; stops once
	/// `need` units are settled.
	fn take(&mut self, rel: arena::Bytes, outcome: Outcome) -> Flow {
		match outcome {
			Outcome::Searched(hit) => {
				self.searched += 1;
				if let Some((hit, collected)) = hit {
					self.units = self
						.units
						.saturating_add(self.search.units(hit.count, collected));
					self.hits.push(hit);
				}
			},
			Outcome::Defer => self.deferred.push(rel),
			Outcome::Skipped => {},
			Outcome::SkippedOversized => self.oversized += 1,
		}
		if self.units >= self.need {
			self.settled = true;
			Flow::Stop
		} else {
			Flow::Continue
		}
	}
}

/// Walks the candidates in path order and searches them from the front in
/// parallel as the walk finds them, normal files first and then (unless the
/// budget is met) the prefixes of files over [`MAX_FILE_BYTES`], stopping the
/// walk and the search as soon as the first `offset + max` results are
/// settled.
#[allow(clippy::too_many_arguments, reason = "the search's shared state")]
fn budgeted<M: Matcher + Sync>(
	search: &Search<'_, M>,
	fs: &Fs,
	root: &Path,
	wopts: &walk::Options,
	filter: &PathFilter,
	opts: &GrepOptions<'_>,
	stop: &dyn Stop,
	max: u64,
) -> Result<GrepResult, GrepError> {
	let tree_opts = TreeOptions {
		hidden: wopts.hidden,
		gitignore: wopts.gitignore,
		skip_git: wopts.skip_git,
		skip_node_modules: wopts.skip_node_modules,
		follow: if wopts.follow_links {
			Follow::Always
		} else {
			Follow::Roots
		},
		order: Order::Paths,
		max_depth: wopts.max_depth,
		same_file_system: wopts.same_file_system,
		..TreeOptions::default()
	};
	// Candidate paths outlive both passes; workers read them through
	// `Bytes::get` while the walk keeps appending.
	let mut paths = arena::Arena::default();
	let mut walked = Ok(Completion::Complete);
	let workers = wopts.parallelism(fs);
	let init = || (Scratch::default(), fs.session());
	let mut budget = Budget {
		search,
		need: opts.offset.saturating_add(max),
		units: 0,
		settled: false,
		hits: Vec::new(),
		deferred: Vec::new(),
		searched: 0,
		oversized: 0,
	};
	let feed = |push: &mut dyn FnMut(arena::Bytes) -> bool| {
		walked = walk::tree(fs, root, &tree_opts, stop, |event| {
			let Event::Entry(entry) = event else {
				return Action::Continue;
			};
			match entry.file_type {
				FileType::Dir if filter.prunes_dir(entry.path) => Action::SkipDir,
				FileType::File if filter.keeps_file(entry.path, entry.name()) => {
					if push(paths.push(&[entry.path])) {
						Action::Continue
					} else {
						Action::Stop
					}
				},
				_ => Action::Skip,
			}
		});
	};
	let complete = exec::streamed(
		workers,
		stop,
		feed,
		init,
		// SAFETY: `paths` outlives every pass.
		|state, rel| search_candidate(search, fs, root, state, unsafe { rel.get() }, false),
		|rel, outcome| budget.take(rel, outcome),
	);
	if !budget.settled {
		walked.map_err(GrepError::Walk)?;
		if !complete {
			return Err(GrepError::Walk(WalkError::Stopped));
		}
	}
	let deferred = std::mem::take(&mut budget.deferred);
	if !budget.settled && !deferred.is_empty() {
		let complete = exec::ordered(
			deferred.len(),
			workers,
			stop,
			init,
			|state, index| {
				// SAFETY: `paths` outlives every pass.
				let rel = unsafe { deferred[index].get() };
				search_candidate(search, fs, root, state, rel, true)
			},
			|index, outcome| budget.take(deferred[index], outcome),
		);
		if !complete && !budget.settled {
			return Err(GrepError::Walk(WalkError::Stopped));
		}
	}
	Ok(aggregate(budget.hits, opts, budget.searched, budget.oversized))
}

/// pi's `aggregate_parallel_results`: applies `offset` and `max_count` to
/// path-ordered hits and totals them.
fn aggregate(
	hits: Vec<FileHit>,
	opts: &GrepOptions<'_>,
	searched: u64,
	oversized: u64,
) -> GrepResult {
	let (offset, max_count) = (opts.offset, opts.max_count);
	let mut result = GrepResult {
		files_searched: searched,
		skipped_oversized: oversized,
		..GrepResult::default()
	};
	let mut skipped = 0u64;
	let mut emitted = 0u64;
	for hit in hits {
		let file_start = result.total_matches;
		result.files_with_matches += 1;
		result.total_matches = result.total_matches.saturating_add(hit.count);
		match opts.mode {
			Mode::Content => {
				let len = hit.matches.len() as u64;
				let skip = offset.saturating_sub(skipped).min(len);
				skipped += skip;
				let available = len - skip;
				let selected =
					max_count.map_or(available, |max| max.saturating_sub(emitted).min(available));
				if selected < available {
					result.limit_reached = true;
				}
				if selected > 0 {
					let selection = hit
						.matches
						.into_iter()
						.skip(skip as usize)
						.take(selected as usize);
					attach(hit.path, selection, &mut result.matches);
					emitted += selected;
				}
				if hit.limit_reached && skipped >= offset {
					result.limit_reached = true;
				}
			},
			Mode::Count => {
				let skip = offset.saturating_sub(file_start).min(hit.count);
				let available = hit.count - skip;
				if available == 0 {
					continue;
				}
				let remaining = max_count.map_or(available, |max| max.saturating_sub(emitted));
				if remaining == 0 {
					result.limit_reached = true;
					continue;
				}
				result
					.matches
					.push(file_entry(Mode::Count, hit.path, hit.count));
				let selected = available.min(remaining);
				emitted = emitted.saturating_add(selected);
				if selected < available {
					result.limit_reached = true;
				}
			},
			Mode::FilesWithMatches => {
				if skipped < offset {
					skipped += 1;
					continue;
				}
				if max_count.is_some_and(|max| emitted >= max) {
					result.limit_reached = true;
					continue;
				}
				result
					.matches
					.push(file_entry(Mode::FilesWithMatches, hit.path, hit.count));
				emitted += 1;
			},
		}
	}
	if max_count.is_some_and(|max| emitted >= max) {
		result.limit_reached = true;
	}
	if max_count == Some(0) {
		result.limit_reached = result.files_with_matches > 0;
	}
	result
}
