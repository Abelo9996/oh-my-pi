//! Structural search and rewrite over files and in-memory sources.
//!
//! [`discover`] lists the candidate files below a root through pi-walker's
//! walker; [`find`] streams each file's matches, [`find_page`] keeps one
//! ordered page of matches across files, and [`rewrite`] stages replacements
//! per file and writes them only after the whole pass succeeded.
//! [`find_source`] and [`rewrite_source`] run the same matching on a string.
//!
//! Every file is parsed in its own language (an explicit language overrides
//! extensions), patterns are compiled once per discovered language, and
//! per-file problems (unknown languages, unreadable files, syntax errors,
//! patterns invalid in one language) become warnings instead of failing the
//! run. Languages whose on-demand grammar is not installed are skipped and
//! reported in [`Report::missing_grammars`].

use std::{
	collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet},
	fmt, io,
	ops::ControlFlow,
	path::{Path, PathBuf},
};

pub use ast_grep_core::MatchStrictness;
use ast_grep_core::{
	AstGrep, Node, NodeMatch, Pattern,
	meta_var::MetaVariable,
	source::Edit,
	tree_sitter::{LanguageExt, StrDoc},
};
use pi_vfs::BlockingFs;
use pi_walker::{
	FileType, Stop,
	glob::Selector,
	walk::{self, Action, WalkError},
};

use crate::{
	language::{SupportLang, grammar::LanguageGrammar},
	ops,
};

#[cfg(test)]
mod tests;

/// A parsed source.
type Ast = AstGrep<StrDoc<SupportLang>>;

/// Why a search or rewrite ended without a result.
#[derive(Debug)]
pub enum Error {
	/// The [`Stop`] fired.
	Stopped,
	/// A directory root could not be walked.
	Root {
		/// The root as walked.
		path:  PathBuf,
		/// What failed.
		error: io::Error,
	},
	/// The request cannot run; the text is the user-facing reason.
	Invalid(String),
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Stopped => f.write_str("search stopped"),
			Self::Root { path, error } => write!(f, "{}: {error}", path.display()),
			Self::Invalid(reason) => f.write_str(reason),
		}
	}
}

impl std::error::Error for Error {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::Root { error, .. } => Some(error),
			Self::Stopped | Self::Invalid(_) => None,
		}
	}
}

impl From<WalkError> for Error {
	fn from(err: WalkError) -> Self {
		match err {
			WalkError::Root { path, error } => Self::Root { path, error },
			WalkError::Stopped => Self::Stopped,
		}
	}
}

/// [`Error::Stopped`] once `stop` fires.
fn check(stop: &dyn Stop) -> Result<(), Error> {
	if stop.stop() {
		Err(Error::Stopped)
	} else {
		Ok(())
	}
}

/// Which files below a directory root [`discover`] keeps.
#[derive(Clone, Copy, Debug, Default)]
pub struct Discover<'a> {
	/// Keep only files this selects; directories it cannot select below are
	/// not entered.
	pub include:      Option<&'a Selector>,
	/// Leave out files and directories (with their subtrees) this selects.
	pub exclude:      Option<&'a Selector>,
	/// Include dot-prefixed entries.
	pub hidden:       bool,
	/// Honour `.ignore`, `.gitignore`, `.git/info/exclude`, and git's global
	/// excludes.
	pub gitignore:    bool,
	/// Descend into `node_modules`.
	pub node_modules: bool,
	/// Follow symlinks to files and directories.
	pub follow_links: bool,
	/// Walking threads; `None` picks the walker's default.
	pub workers:      Option<usize>,
	/// Keep files whose name maps to no language (an explicit language will
	/// parse them).
	pub any_file:     bool,
}

/// A file to search.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
	/// Absolute path in the filesystem's spelling, read and written through.
	pub path:    PathBuf,
	/// Path shown in results: walk-relative and `/`-separated below a
	/// directory root, the file name for a file root.
	pub display: String,
}

/// The files below `root` (an absolute host path or `scheme://` URL) that
/// `opts` keeps, in path order. A file root is its own only candidate (when
/// its name maps to a language or [`Discover::any_file`] is set); the globs do
/// not apply to it.
///
/// # Errors
/// [`Error::Invalid`] when `root` does not exist or is neither file nor
/// directory, [`Error::Root`] when it cannot be walked, [`Error::Stopped`].
pub fn discover(
	fs: &BlockingFs,
	root: &Path,
	opts: &Discover<'_>,
	stop: &dyn Stop,
) -> Result<Vec<Candidate>, Error> {
	let root = pi_walker::fs::canonical(fs, root.to_path_buf());
	let metadata = fs
		.metadata(&root)
		.map_err(|err| Error::Invalid(format!("Path not found: {err}")))?;
	let has_language = |path: &Path| opts.any_file || SupportLang::from_path(path).is_some();
	if metadata.is_file() {
		if !has_language(root.as_path()) {
			return Ok(Vec::new());
		}
		let display = pi_vfs::file_name(&root)
			.and_then(|name| name.to_str().map(str::to_string))
			.unwrap_or_else(|| root.to_string_lossy().into_owned());
		return Ok(vec![Candidate { path: root, display }]);
	}
	if !metadata.is_dir() {
		return Err(Error::Invalid(format!(
			"Search path must be a file or directory: {}",
			root.display()
		)));
	}

	let walk_fs = pi_walker::Fs::new(fs, &root);
	let walk_opts = walk::Options {
		hidden: opts.hidden,
		gitignore: opts.gitignore,
		skip_git: true,
		skip_node_modules: !opts.node_modules,
		follow_links: opts.follow_links,
		workers: opts.workers,
		cache: true,
		..Default::default()
	};
	let excluded = |path: &[u8]| opts.exclude.is_some_and(|exclude| exclude.matches(path));
	let collection =
		walk::collect(&walk_fs, &root, &walk_opts, true, stop, |_, entry| match entry.file_type {
			FileType::Dir
				if excluded(entry.path)
					|| opts
						.include
						.is_some_and(|include| include.prunes(entry.path)) =>
			{
				Action::SkipDir
			},
			FileType::File
				if opts
					.include
					.is_none_or(|include| include.matches(entry.path))
					&& !excluded(entry.path)
					&& has_language(entry.rel_path()) =>
			{
				Action::Continue
			},
			_ => Action::Skip,
		})?;
	Ok(collection
		.iter()
		.map(|entry| Candidate {
			path:    walk_fs.join(&root, entry.path),
			display: entry.path_lossy().into_owned(),
		})
		.collect())
}

/// A source position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pos {
	/// 0-based line.
	pub line:   usize,
	/// 0-based column in characters.
	pub column: usize,
}

/// A source range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Span {
	/// Start byte offset.
	pub start:     usize,
	/// End byte offset (exclusive).
	pub end:       usize,
	/// Position of `start`.
	pub start_pos: Pos,
	/// Position of `end`.
	pub end_pos:   Pos,
}

impl Span {
	fn of(node: &Node<'_, StrDoc<SupportLang>>) -> Self {
		let range = node.range();
		let start = node.start_pos();
		let end = node.end_pos();
		Self {
			start:     range.start,
			end:       range.end,
			start_pos: Pos { line: start.line(), column: start.column(node) },
			end_pos:   Pos { line: end.line(), column: end.column(node) },
		}
	}
}

/// Text a meta-variable captured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
	/// Captured source text.
	pub text: String,
	/// Where it was captured.
	pub span: Span,
}

impl Capture {
	fn of(node: &Node<'_, StrDoc<SupportLang>>) -> Self {
		Self { text: node.text().into_owned(), span: Span::of(node) }
	}
}

/// A match's meta-variable bindings.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Captures {
	/// `$NAME` bindings.
	pub single: BTreeMap<String, Capture>,
	/// `$$$NAME` bindings, one capture per node.
	pub multi:  BTreeMap<String, Vec<Capture>>,
}

impl Captures {
	fn of(matched: &NodeMatch<'_, StrDoc<SupportLang>>) -> Self {
		let env = matched.get_env();
		let mut captures = Self::default();
		for variable in env.get_matched_variables() {
			match variable {
				MetaVariable::Capture(name, _) => {
					if let Some(node) = env.get_match(&name) {
						captures.single.insert(name, Capture::of(node));
					}
				},
				MetaVariable::MultiCapture(name) => {
					let nodes = env.get_multiple_matches(&name);
					captures
						.multi
						.insert(name, nodes.iter().map(Capture::of).collect());
				},
				_ => {},
			}
		}
		captures
	}
}

/// One pattern match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
	/// Matched range.
	pub span:     Span,
	/// Matched source text.
	pub text:     String,
	/// Meta-variable bindings, when [`Query::captures`] asked for them.
	pub captures: Option<Captures>,
}

impl Match {
	fn of(matched: &NodeMatch<'_, StrDoc<SupportLang>>, captures: bool) -> Self {
		Self {
			span:     Span::of(matched.get_node()),
			text:     matched.text().into_owned(),
			captures: captures.then(|| Captures::of(matched)),
		}
	}
}

/// What to search for.
#[derive(Clone)]
pub struct Query<'a> {
	/// Patterns, matched independently (OR).
	pub patterns:   &'a [String],
	/// Language alias every file is parsed as; `None` infers it per file
	/// from the file name.
	pub lang:       Option<&'a str>,
	/// Node kind the patterns are parsed as, for fragments.
	pub selector:   Option<&'a str>,
	/// How closely patterns must match.
	pub strictness: MatchStrictness,
	/// Collect meta-variable bindings.
	pub captures:   bool,
}

/// Diagnostics of a file search or rewrite.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
	/// Files examined (unknown-language files included, files of missing
	/// grammars not).
	pub files_searched:   usize,
	/// Pattern, language, read, and syntax problems, in order.
	pub warnings:         Vec<String>,
	/// Languages skipped because their on-demand grammar is not installed.
	pub missing_grammars: Vec<&'static str>,
}

/// The matches in one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileMatches {
	/// Absolute path the file was read from.
	pub path:     PathBuf,
	/// Display path ([`Candidate::display`]).
	pub display:  String,
	/// Language the file was parsed as.
	pub language: SupportLang,
	/// File contents.
	pub source:   String,
	/// Matches in position order.
	pub matches:  Vec<Match>,
}

/// Searches `candidates` in order, handing every file with a match to
/// `on_file` until it breaks.
///
/// # Errors
/// [`Error::Stopped`].
pub fn find(
	fs: &BlockingFs,
	candidates: Vec<Candidate>,
	query: &Query<'_>,
	stop: &dyn Stop,
	mut on_file: impl FnMut(FileMatches) -> ControlFlow<()>,
) -> Result<Report, Error> {
	scan(fs, candidates, query, stop, |candidate, language, source, ast, patterns| {
		let mut matches = Vec::new();
		for pattern in patterns {
			check(stop)?;
			for matched in ast.root().find_all((*pattern).clone()) {
				check(stop)?;
				matches.push(Match::of(&matched, query.captures));
			}
		}
		if matches.is_empty() {
			return Ok(ControlFlow::Continue(()));
		}
		matches.sort_by_key(|matched| matched.span);
		Ok(on_file(FileMatches {
			path: candidate.path,
			display: candidate.display,
			language,
			source,
			matches,
		}))
	})
}

/// A window of ordered matches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Page {
	/// Leading matches skipped.
	pub offset: usize,
	/// Most matches kept after `offset`.
	pub limit:  usize,
}

/// A match of [`find_page`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
	/// Display path of the matching file.
	pub display: String,
	/// The match.
	pub matched: Match,
}

/// One page of matches across files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindPage {
	/// The page, ordered by file, then position.
	pub hits:               Vec<Hit>,
	/// Matches found before paging.
	pub total_matches:      usize,
	/// Files with at least one match.
	pub files_with_matches: usize,
	/// Matches beyond the page exist.
	pub limit_reached:      bool,
	/// Diagnostics.
	pub report:             Report,
}

/// Searches `candidates`, keeping only the `page` of matches ordered by file
/// (candidate order), then position.
///
/// # Errors
/// [`Error::Stopped`].
pub fn find_page(
	fs: &BlockingFs,
	candidates: Vec<Candidate>,
	query: &Query<'_>,
	page: Page,
	stop: &dyn Stop,
) -> Result<FindPage, Error> {
	let mut window = Window::new(page);
	let mut displays = Vec::new();
	let mut files_with_matches = 0;
	let report = scan(fs, candidates, query, stop, |candidate, _, _, ast, patterns| {
		let before = window.total;
		for pattern in patterns {
			check(stop)?;
			for matched in ast.root().find_all((*pattern).clone()) {
				check(stop)?;
				window.offer(displays.len(), &matched, query.captures);
			}
		}
		if window.total > before {
			files_with_matches += 1;
		}
		displays.push(candidate.display);
		Ok(ControlFlow::Continue(()))
	})?;
	let total_matches = window.total;
	let (retained, limit_reached) = window.into_page();
	let hits = retained
		.into_iter()
		.map(|retained| Hit {
			display: displays[retained.key.file].clone(),
			matched: retained.matched,
		})
		.collect();
	Ok(FindPage { hits, total_matches, files_with_matches, limit_reached, report })
}

/// Matches of [`find_source`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceMatches {
	/// The page, in position order.
	pub matches:       Vec<Match>,
	/// Matches found before paging.
	pub total_matches: usize,
	/// Matches beyond the page exist.
	pub limit_reached: bool,
	/// Pattern and syntax problems.
	pub warnings:      Vec<String>,
}

/// Searches `source` as `language`, keeping the `page` of matches in position
/// order; [`Query::lang`] is ignored.
///
/// # Errors
/// [`Error::Invalid`] when the language's grammar cannot load,
/// [`Error::Stopped`].
pub fn find_source(
	source: &str,
	language: SupportLang,
	query: &Query<'_>,
	page: Page,
	stop: &dyn Stop,
) -> Result<SourceMatches, Error> {
	load_grammar(language)?;
	let mut warnings = Vec::new();
	let mut patterns = Vec::with_capacity(query.patterns.len());
	for pattern in query.patterns {
		check(stop)?;
		match ops::compile_pattern(pattern, query.selector, &query.strictness, language) {
			Ok(compiled) => {
				warnings.extend(error_node_warning(pattern, &compiled, language));
				patterns.push(compiled);
			},
			Err(err) => warnings.push(format!("{pattern}: {err}")),
		}
	}

	let mut window = Window::new(page);
	if !patterns.is_empty() {
		let ast = language.ast_grep(source);
		if has_parse_error(&ast) {
			warnings.push("parse error (syntax tree contains error nodes)".to_string());
		}
		for pattern in &patterns {
			check(stop)?;
			for matched in ast.root().find_all(pattern.clone()) {
				check(stop)?;
				window.offer(0, &matched, query.captures);
			}
		}
	}
	let total_matches = window.total;
	let (retained, limit_reached) = window.into_page();
	Ok(SourceMatches {
		matches: retained
			.into_iter()
			.map(|retained| retained.matched)
			.collect(),
		total_matches,
		limit_reached,
		warnings,
	})
}

/// What [`rewrite`] does with the replacements it computes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
	/// Report the changes only.
	Preview,
	/// Also compute each touched file's new contents.
	Render,
	/// Render, then write every touched file once the whole pass succeeded.
	Write,
}

/// A structural rewrite.
#[derive(Clone)]
pub struct Rewrite<'a> {
	/// `(pattern, replacement template)` rules, applied in order.
	pub rules:               &'a [(String, String)],
	/// Language alias every file is parsed as; `None` infers it per file.
	pub lang:                Option<&'a str>,
	/// Node kind the patterns are parsed as, for fragments.
	pub selector:            Option<&'a str>,
	/// How closely patterns must match.
	pub strictness:          MatchStrictness,
	/// Most replacements across all files.
	pub max_replacements:    usize,
	/// Most files changed.
	pub max_files:           usize,
	/// Fail on the first unparsable file or pattern instead of skipping it
	/// with a warning.
	pub fail_on_parse_error: bool,
	/// Drop a match overlapping an edit already kept in its file instead of
	/// failing the render on the ambiguous overlap.
	pub skip_overlaps:       bool,
	/// What to do with the replacements.
	pub mode:                Mode,
}

/// One replacement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
	/// Replaced range.
	pub span:           Span,
	/// Replaced text.
	pub before:         String,
	/// Replacement text.
	pub after:          String,
	/// Bytes deleted.
	pub deleted_length: usize,
}

/// The replacements in one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEdit {
	/// Absolute path the file was read from (and is written to).
	pub path:     PathBuf,
	/// Display path ([`Candidate::display`]).
	pub display:  String,
	/// Language the file was parsed as.
	pub language: SupportLang,
	/// Original contents.
	pub source:   String,
	/// Replacements, rule by rule in match order.
	pub changes:  Vec<Change>,
	/// New contents ([`Mode::Render`] and [`Mode::Write`]).
	pub content:  Option<String>,
}

/// Outcome of [`rewrite`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edited {
	/// Files with replacements, in candidate order.
	pub files:         Vec<FileEdit>,
	/// [`Rewrite::max_replacements`] or [`Rewrite::max_files`] stopped the
	/// pass.
	pub limit_reached: bool,
	/// Diagnostics.
	pub report:        Report,
}

/// Rewrites `candidates` in order. Files with syntax errors are skipped (or
/// fail the run); in [`Mode::Write`] nothing is written unless every file
/// rendered.
///
/// # Errors
/// [`Error::Invalid`] for a parse failure under
/// [`Rewrite::fail_on_parse_error`], an ambiguous overlap, or a failed write;
/// [`Error::Stopped`].
pub fn rewrite(
	fs: &BlockingFs,
	candidates: Vec<Candidate>,
	rewrite: &Rewrite<'_>,
	stop: &dyn Stop,
) -> Result<Edited, Error> {
	let prepared = resolve(candidates, rewrite.lang, stop)?;
	let mut report = Report {
		files_searched:   prepared.files.len(),
		warnings:         Vec::new(),
		missing_grammars: prepared.missing_grammars.iter().copied().collect(),
	};
	let warnings = &mut report.warnings;

	let mut rules = Vec::with_capacity(rewrite.rules.len());
	for (pattern, template) in rewrite.rules {
		check(stop)?;
		let by_lang = compile_for(
			pattern,
			&prepared.languages,
			rewrite.selector,
			&rewrite.strictness,
			warnings,
			stop,
		)?;
		// A pattern that parses in no discovered language is a genuine pattern
		// error; failing in only some languages of a mixed tree is expected
		// and surfaces per skipped file below.
		if !prepared.languages.is_empty() && by_lang.values().all(Result::is_err) {
			let mut errors = by_lang
				.iter()
				.filter_map(|(key, result)| Some((key, result.as_ref().err()?)));
			if rewrite.fail_on_parse_error {
				let (_, err) = errors
					.next()
					.expect("compile failure recorded for every language");
				return Err(Error::Invalid(format!("{pattern}: {err}")));
			}
			for (key, err) in errors {
				warnings.push(if prepared.languages.len() > 1 {
					format!("{pattern} ({key}): {err}")
				} else {
					format!("{pattern}: {err}")
				});
			}
			continue;
		}
		rules.push(CompiledRule { pattern, template: template.as_str(), by_lang });
	}
	// Compile diagnostics precede file diagnostics.
	warnings.sort();

	let mut files = Vec::new();
	let mut total = 0;
	let mut limit_reached = false;
	if !rules.is_empty() {
		for Resolved { candidate, language } in prepared.files {
			check(stop)?;
			let fail = rewrite.fail_on_parse_error;
			let language = match language {
				Ok(language) => language,
				Err(error) => {
					skip(fail, warnings, format!("{}: {error}", candidate.display))?;
					continue;
				},
			};
			let key = language.canonical_name();
			let mut runnable = Vec::new();
			for rule in &rules {
				check(stop)?;
				match rule.by_lang.get(key) {
					Some(Ok(pattern)) => runnable.push((rule.template, pattern)),
					Some(Err(error)) => {
						warnings.push(format!("{}: {}: {error}", rule.pattern, candidate.display));
					},
					None => {},
				}
			}
			if runnable.is_empty() {
				continue;
			}
			let source = match fs.read_to_string(&candidate.path) {
				Ok(source) => source,
				Err(err) => {
					skip(fail, warnings, format!("{}: {err}", candidate.display))?;
					continue;
				},
			};
			let ast = language.ast_grep(&source);
			if has_parse_error(&ast) {
				let issue =
					format!("{}: parse error (syntax tree contains error nodes)", candidate.display);
				skip(fail, warnings, issue)?;
				continue;
			}

			let staged = stage(
				&ast,
				&runnable,
				rewrite.max_replacements.saturating_sub(total),
				rewrite.skip_overlaps,
				Some(candidate.display.as_str()),
				stop,
			)?;
			limit_reached |= staged.limit_reached;
			if staged.changes.is_empty() {
				if staged.limit_reached {
					break;
				}
				continue;
			}
			if files.len() >= rewrite.max_files {
				limit_reached = true;
				break;
			}
			total += staged.changes.len();
			let content = match rewrite.mode {
				Mode::Preview => None,
				Mode::Render | Mode::Write => Some(render(&source, &staged.edits)?),
			};
			files.push(FileEdit {
				path: candidate.path,
				display: candidate.display,
				language,
				source,
				changes: staged.changes,
				content,
			});
			if staged.limit_reached {
				break;
			}
		}
	}

	if rewrite.mode == Mode::Write {
		for file in &files {
			check(stop)?;
			if let Some(content) = &file.content
				&& *content != file.source
			{
				fs.write(&file.path, content).map_err(|err| {
					Error::Invalid(format!("Failed to write {}: {err}", file.path.display()))
				})?;
			}
		}
	}
	Ok(Edited { files, limit_reached, report })
}

/// Records `issue` as a warning, or fails with it when `fail` is set.
fn skip(fail: bool, warnings: &mut Vec<String>, issue: String) -> Result<(), Error> {
	if fail {
		return Err(Error::Invalid(issue));
	}
	warnings.push(issue);
	Ok(())
}

/// Outcome of [`rewrite_source`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceEdit {
	/// Replacements, rule by rule in match order.
	pub changes:  Vec<Change>,
	/// The rewritten source.
	pub content:  String,
	/// Pattern and syntax problems.
	pub warnings: Vec<String>,
}

/// Rewrites `source` as `language`; [`Rewrite::lang`], [`Rewrite::max_files`],
/// and [`Rewrite::mode`] are ignored. A source with syntax errors is left
/// unchanged with a warning (or fails under
/// [`Rewrite::fail_on_parse_error`]).
///
/// # Errors
/// [`Error::Invalid`] when the grammar cannot load, for a parse failure under
/// [`Rewrite::fail_on_parse_error`], or an ambiguous overlap;
/// [`Error::Stopped`].
pub fn rewrite_source(
	source: &str,
	language: SupportLang,
	rewrite: &Rewrite<'_>,
	stop: &dyn Stop,
) -> Result<SourceEdit, Error> {
	load_grammar(language)?;
	let mut warnings = Vec::new();
	let mut rules = Vec::with_capacity(rewrite.rules.len());
	for (pattern, template) in rewrite.rules {
		check(stop)?;
		match ops::compile_pattern(pattern, rewrite.selector, &rewrite.strictness, language) {
			Ok(compiled) => {
				warnings.extend(error_node_warning(pattern, &compiled, language));
				rules.push((template.as_str(), compiled));
			},
			Err(err) if rewrite.fail_on_parse_error => {
				return Err(Error::Invalid(format!("{pattern}: {err}")));
			},
			Err(err) => warnings.push(format!("{pattern}: {err}")),
		}
	}
	let unchanged = |warnings: Vec<String>| SourceEdit {
		changes: Vec::new(),
		content: source.to_string(),
		warnings,
	};
	if rules.is_empty() {
		return Ok(unchanged(warnings));
	}
	let ast = language.ast_grep(source);
	if has_parse_error(&ast) {
		let issue = "parse error (syntax tree contains error nodes)".to_string();
		if rewrite.fail_on_parse_error {
			return Err(Error::Invalid(issue));
		}
		warnings.push(issue);
		return Ok(unchanged(warnings));
	}
	let runnable: Vec<_> = rules
		.iter()
		.map(|(template, pattern)| (*template, pattern))
		.collect();
	let staged =
		stage(&ast, &runnable, rewrite.max_replacements, rewrite.skip_overlaps, None, stop)?;
	let content = render(source, &staged.edits)?;
	Ok(SourceEdit { changes: staged.changes, content, warnings })
}

/// A candidate with its language, or why it has none.
struct Resolved {
	candidate: Candidate,
	language:  Result<SupportLang, String>,
}

/// Candidates with their languages, the distinct languages to compile
/// patterns for (by canonical name), and the languages skipped because their
/// on-demand grammar is not installed.
struct Prepared {
	files:            Vec<Resolved>,
	languages:        BTreeMap<&'static str, SupportLang>,
	missing_grammars: BTreeSet<&'static str>,
}

fn resolve(
	candidates: Vec<Candidate>,
	lang: Option<&str>,
	stop: &dyn Stop,
) -> Result<Prepared, Error> {
	let mut files = Vec::with_capacity(candidates.len());
	let mut languages = BTreeMap::new();
	let mut missing_grammars = BTreeSet::new();
	let mut installed = HashMap::new();
	for candidate in candidates {
		check(stop)?;
		match ops::resolve_language(lang, &candidate.path) {
			Ok(language) => {
				let available = *installed.entry(language).or_insert_with(|| {
					language
						.wasm_grammar()
						.is_none_or(|grammar| grammar.is_installed())
				});
				if !available {
					missing_grammars.insert(language.canonical_name());
					continue;
				}
				languages
					.entry(language.canonical_name())
					.or_insert(language);
				files.push(Resolved { candidate, language: Ok(language) });
			},
			Err(err) => files.push(Resolved { candidate, language: Err(err.to_string()) }),
		}
	}
	Ok(Prepared { files, languages, missing_grammars })
}

/// `pattern` compiled for every language (by canonical name), or why it does
/// not compile there; ERROR-node warnings go to `warnings`.
fn compile_for(
	pattern: &str,
	languages: &BTreeMap<&'static str, SupportLang>,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	warnings: &mut Vec<String>,
	stop: &dyn Stop,
) -> Result<BTreeMap<&'static str, Result<Pattern, String>>, Error> {
	let mut compiled = BTreeMap::new();
	for (&key, &language) in languages {
		check(stop)?;
		let result = ops::compile_pattern(pattern, selector, strictness, language)
			.inspect(|compiled| warnings.extend(error_node_warning(pattern, compiled, language)))
			.map_err(|err| err.to_string());
		compiled.insert(key, result);
	}
	Ok(compiled)
}

/// A search pattern compiled for every discovered language.
struct CompiledPattern<'a> {
	pattern: &'a str,
	by_lang: BTreeMap<&'static str, Result<Pattern, String>>,
}

/// A rewrite rule compiled for every discovered language. A rule that fails
/// to parse in one language of a mixed tree skips that language's files
/// instead of failing the run.
struct CompiledRule<'a> {
	pattern:  &'a str,
	template: &'a str,
	by_lang:  BTreeMap<&'static str, Result<Pattern, String>>,
}

/// Resolves and compiles, then parses every file that has a runnable pattern
/// and hands it to `visit` with those patterns until it breaks. Per-file
/// problems become warnings.
fn scan(
	fs: &BlockingFs,
	candidates: Vec<Candidate>,
	query: &Query<'_>,
	stop: &dyn Stop,
	mut visit: impl FnMut(
		Candidate,
		SupportLang,
		String,
		&Ast,
		&[&Pattern],
	) -> Result<ControlFlow<()>, Error>,
) -> Result<Report, Error> {
	let prepared = resolve(candidates, query.lang, stop)?;
	let mut warnings = Vec::new();
	let mut compiled = Vec::with_capacity(query.patterns.len());
	for pattern in query.patterns {
		check(stop)?;
		let by_lang = compile_for(
			pattern,
			&prepared.languages,
			query.selector,
			&query.strictness,
			&mut warnings,
			stop,
		)?;
		compiled.push(CompiledPattern { pattern, by_lang });
	}
	warnings.sort();

	let files_searched = prepared.files.len();
	for Resolved { candidate, language } in prepared.files {
		check(stop)?;
		let language = match language {
			Ok(language) => language,
			Err(error) => {
				for pattern in &compiled {
					warnings.push(format!("{}: {}: {error}", pattern.pattern, candidate.display));
				}
				continue;
			},
		};
		let source = match fs.read_to_string(&candidate.path) {
			Ok(source) => source,
			Err(err) => {
				for pattern in &compiled {
					warnings.push(format!("{}: {}: {err}", pattern.pattern, candidate.display));
				}
				continue;
			},
		};
		let key = language.canonical_name();
		let mut runnable = Vec::new();
		for pattern in &compiled {
			check(stop)?;
			match pattern.by_lang.get(key) {
				Some(Ok(pattern)) => runnable.push(pattern),
				Some(Err(error)) => {
					warnings.push(format!("{}: {}: {error}", pattern.pattern, candidate.display));
				},
				None => {},
			}
		}
		if runnable.is_empty() {
			continue;
		}
		let ast = language.ast_grep(&source);
		if has_parse_error(&ast) {
			warnings
				.push(format!("{}: parse error (syntax tree contains error nodes)", candidate.display));
		}
		if visit(candidate, language, source, &ast, &runnable)?.is_break() {
			break;
		}
	}
	Ok(Report {
		files_searched,
		warnings,
		missing_grammars: prepared.missing_grammars.into_iter().collect(),
	})
}

/// Replacements staged for one source.
struct Staged {
	changes:       Vec<Change>,
	edits:         Vec<Edit<String>>,
	/// The replacement budget ran out.
	limit_reached: bool,
}

/// Stages every `(template, pattern)` replacement in `ast`, at most `budget`
/// of them. Byte-identical edits (several rules rewriting one node the same
/// way) are staged once.
fn stage(
	ast: &Ast,
	rules: &[(&str, &Pattern)],
	budget: usize,
	skip_overlaps: bool,
	display: Option<&str>,
	stop: &dyn Stop,
) -> Result<Staged, Error> {
	let mut staged =
		Staged { changes: Vec::new(), edits: Vec::new(), limit_reached: false };
	let mut seen = HashSet::new();
	// Kept spans by start; disjoint, so only the nearest earlier start can
	// overlap a new span.
	let mut kept = BTreeMap::new();
	'rules: for &(template, pattern) in rules {
		for matched in ast.root().find_all(pattern.clone()) {
			check(stop)?;
			let edit = matched.replace_by(template);
			if !seen.insert((edit.position, edit.deleted_length, edit.inserted_text.clone())) {
				continue;
			}
			let end = edit.position + edit.deleted_length;
			if skip_overlaps
				&& kept
					.range(..end)
					.next_back()
					.is_some_and(|(_, &kept_end)| kept_end > edit.position)
			{
				continue;
			}
			if staged.changes.len() >= budget {
				staged.limit_reached = true;
				break 'rules;
			}
			let after = String::from_utf8(edit.inserted_text.clone()).map_err(|err| {
				Error::Invalid(match display {
					Some(display) => format!("{display}: replacement text is not valid UTF-8: {err}"),
					None => format!("replacement text is not valid UTF-8: {err}"),
				})
			})?;
			kept.insert(edit.position, end);
			staged.changes.push(Change {
				span: Span::of(matched.get_node()),
				before: matched.text().into_owned(),
				after,
				deleted_length: edit.deleted_length,
			});
			staged.edits.push(edit);
		}
	}
	Ok(staged)
}

/// `source` with `edits` applied.
fn render(source: &str, edits: &[Edit<String>]) -> Result<String, Error> {
	ops::apply_edits(source, edits).map_err(|err| Error::Invalid(err.to_string()))
}

fn load_grammar(language: SupportLang) -> Result<(), Error> {
	language
		.grammar()
		.load()
		.map(drop)
		.map_err(|err| Error::Invalid(err.to_string()))
}

/// Whether the tree has syntax errors; recovery can insert missing tokens
/// without producing an ERROR node.
fn has_parse_error(ast: &Ast) -> bool {
	ast.root()
		.dfs()
		.any(|node| node.is_error() || node.is_missing())
}

/// The ast-grep CLI's "Pattern contains an ERROR node" warning for a pattern
/// that compiled although its own parse tree is rooted at an ERROR node. Such
/// a pattern matches loosely or not at all, so it is reported instead of
/// letting an empty result read as absence.
fn error_node_warning(pattern: &str, compiled: &Pattern, language: SupportLang) -> Option<String> {
	compiled.has_error().then(|| {
		// Keep the diagnostic on one bounded display line; the original
		// pattern is still used for matching.
		let mut preview = String::new();
		let mut width = 0;
		for ch in pattern.chars() {
			let escaped = ch.is_control() || (ch.is_whitespace() && ch != ' ');
			let char_width = if escaped {
				ch.escape_unicode().count()
			} else {
				xutf::width_char(ch).max(1)
			};
			if width + char_width > 48 {
				preview.push('…');
				break;
			}
			if escaped {
				preview.extend(ch.escape_unicode());
			} else {
				preview.push(ch);
			}
			width += char_width;
		}
		format!(
			"{preview}: pattern is not valid {} on its own (contains an ERROR node); matches may be \
			 missing or unexpected",
			language.canonical_name()
		)
	})
}

/// Order of a match among all matches: file (candidate order), then span,
/// then discovery order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
	file:     usize,
	start:    usize,
	end:      usize,
	sequence: u64,
}

/// A match kept for the page.
#[derive(Debug, PartialEq, Eq)]
struct Retained {
	key:     Key,
	matched: Match,
}

impl Ord for Retained {
	fn cmp(&self, other: &Self) -> std::cmp::Ordering {
		self.key.cmp(&other.key)
	}
}

impl PartialOrd for Retained {
	fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
		Some(self.cmp(other))
	}
}

/// The best `offset + limit + 1` matches seen so far (one past the page, to
/// tell whether more exist); a match is materialized only when it enters.
struct Window {
	page:     Page,
	capacity: usize,
	heap:     BinaryHeap<Retained>,
	total:    usize,
	sequence: u64,
}

impl Window {
	fn new(page: Page) -> Self {
		Self {
			page,
			capacity: page.offset.saturating_add(page.limit).saturating_add(1),
			heap: BinaryHeap::new(),
			total: 0,
			sequence: 0,
		}
	}

	/// Counts `matched` in file `file` and keeps it if it ranks in the window.
	fn offer(&mut self, file: usize, matched: &NodeMatch<'_, StrDoc<SupportLang>>, captures: bool) {
		self.total += 1;
		let range = matched.range();
		let key = Key { file, start: range.start, end: range.end, sequence: self.sequence };
		self.sequence += 1;
		if self.admits(&key) {
			self.retain(Retained { key, matched: Match::of(matched, captures) });
		}
	}

	/// Whether a match ordered by `key` would enter the window.
	fn admits(&self, key: &Key) -> bool {
		self.heap.len() < self.capacity || self.heap.peek().is_some_and(|worst| *key < worst.key)
	}

	fn retain(&mut self, candidate: Retained) {
		if self.heap.len() < self.capacity {
			self.heap.push(candidate);
			return;
		}
		if let Some(mut worst) = self.heap.peek_mut()
			&& candidate.key < worst.key
		{
			*worst = candidate;
		}
	}

	/// The page in order, and whether matches beyond it exist.
	fn into_page(self) -> (Vec<Retained>, bool) {
		let retained = self.heap.into_sorted_vec();
		let limit_reached = retained.len().saturating_sub(self.page.offset) > self.page.limit;
		let page = retained
			.into_iter()
			.skip(self.page.offset)
			.take(self.page.limit)
			.collect();
		(page, limit_reached)
	}
}
