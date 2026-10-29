//! Ordered parallel execution over an indexed candidate list.
//!
//! [`ordered`] runs `work` for items `0..len` on several threads while the
//! calling thread consumes results strictly in index order, so output is
//! deterministic and a consumer can stop once it has what it needs: workers
//! claim indices front to back, at most a bounded window ahead of the
//! consumed prefix, and abandon the rest once the consumer stops.
//!
//! Used by searches that must report the first results in path order
//! (`grep` with a match budget, the shell's `rg`/`grep`, which write each
//! file's output as soon as every earlier file's output is written).
//!
//! ```ignore
//! let mut lines = Vec::new();
//! exec::ordered(files.len(), 4, &Never, Vec::new, |buf, i| search(buf, &files[i]), |_, out| {
//!     lines.extend(out);
//!     Flow::Continue
//! });
//! ```

use parking_lot::{Condvar, Mutex};

use crate::walk::Stop;

/// A consumer's decision after one result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flow {
	/// Keep consuming.
	Continue,
	/// Stop: remaining items are abandoned (in-flight ones finish and are
	/// dropped).
	Stop,
}

/// How many items per worker may be claimed ahead of the consumed prefix.
const WINDOW_PER_WORKER: usize = 16;

/// Results waiting for the consumer: slot `i % window` holds item `i` once
/// done, for `consumed <= i < consumed + window`.
struct Ring<R> {
	slots:     Vec<Option<R>>,
	/// Items handed to the consumer so far.
	consumed:  usize,
	/// Next index to claim.
	next:      usize,
	/// The consumer stopped or `stop` fired; nothing more is claimed.
	abandoned: bool,
}

struct Shared<R> {
	ring:  Mutex<Ring<R>>,
	/// Signalled when the item the consumer waits for is stored.
	ready: Condvar,
	/// Signalled when the window moves or the run is abandoned.
	space: Condvar,
}

/// Runs `work(state, index)` for every index in `0..len`.
///
/// Work runs on up to `workers` threads (each with its own `init()` state;
/// `workers <= 1` runs inline), and each result is handed to
/// `consume(index, result)` on the calling thread in index order. Returns
/// false when `consume` or `stop` ended it early.
pub fn ordered<S, R, I, W, C>(
	len: usize,
	workers: usize,
	stop: &dyn Stop,
	init: I,
	work: W,
	mut consume: C,
) -> bool
where
	S: Send,
	R: Send,
	I: Fn() -> S + Sync,
	W: Fn(&mut S, usize) -> R + Sync,
	C: FnMut(usize, R) -> Flow,
{
	let workers = workers.min(len);
	if workers <= 1 {
		let mut state = init();
		for index in 0..len {
			if stop.stop() {
				return false;
			}
			if consume(index, work(&mut state, index)) == Flow::Stop {
				return false;
			}
		}
		return true;
	}
	let window = workers * WINDOW_PER_WORKER;
	let shared = Shared {
		ring:  Mutex::new(Ring {
			slots:     (0..window).map(|_| None).collect(),
			consumed:  0,
			next:      0,
			abandoned: false,
		}),
		ready: Condvar::new(),
		space: Condvar::new(),
	};
	std::thread::scope(|scope| {
		for _ in 0..workers {
			scope.spawn(|| run_worker(&shared, len, window, stop, &init, &work));
		}
		// Releases waiting workers however consumption ends, a panicking
		// consumer included.
		let _abandon = Abandon { shared: &shared, always: true };
		consume_in_order(&shared, len, window, stop, &mut consume)
	})
}

fn run_worker<S, R, I, W>(
	shared: &Shared<R>,
	len: usize,
	window: usize,
	stop: &dyn Stop,
	init: &I,
	work: &W,
) where
	I: Fn() -> S,
	W: Fn(&mut S, usize) -> R,
{
	let _guard = Abandon { shared, always: false };
	let mut state = None;
	loop {
		let index = {
			let mut ring = shared.ring.lock();
			loop {
				if ring.abandoned || ring.next >= len {
					return;
				}
				if stop.stop() {
					ring.abandoned = true;
					drop(ring);
					shared.space.notify_all();
					shared.ready.notify_one();
					return;
				}
				if ring.next < ring.consumed + window {
					break;
				}
				shared.space.wait(&mut ring);
			}
			ring.next += 1;
			ring.next - 1
		};
		let result = work(state.get_or_insert_with(init), index);
		let mut ring = shared.ring.lock();
		if ring.abandoned {
			return;
		}
		ring.slots[index % window] = Some(result);
		let wanted = ring.consumed == index;
		drop(ring);
		if wanted {
			shared.ready.notify_one();
		}
	}
}

/// Abandons the run on drop (`always`) or when its thread panics, so no
/// thread waits for a result or a window move that will not come; the scope
/// re-raises any panic.
struct Abandon<'a, R> {
	shared: &'a Shared<R>,
	always: bool,
}

impl<R> Drop for Abandon<'_, R> {
	fn drop(&mut self) {
		if self.always || std::thread::panicking() {
			self.shared.ring.lock().abandoned = true;
			self.shared.space.notify_all();
			self.shared.ready.notify_all();
		}
	}
}

/// Hands results to `consume` in index order; false when it stopped early.
fn consume_in_order<R, C>(
	shared: &Shared<R>,
	len: usize,
	window: usize,
	stop: &dyn Stop,
	consume: &mut C,
) -> bool
where
	C: FnMut(usize, R) -> Flow,
{
	for index in 0..len {
		let result = {
			let mut ring = shared.ring.lock();
			loop {
				if let Some(result) = ring.slots[index % window].take() {
					break result;
				}
				if ring.abandoned || stop.stop() {
					return false;
				}
				shared.ready.wait(&mut ring);
			}
		};
		if stop.stop() {
			return false;
		}
		shared.ring.lock().consumed = index + 1;
		shared.space.notify_all();
		if consume(index, result) == Flow::Stop {
			return false;
		}
	}
	true
}

#[cfg(test)]
mod tests {
	use std::{
		sync::atomic::{AtomicBool, AtomicUsize, Ordering},
		time::Duration,
	};

	use super::*;
	use crate::walk::Never;

	/// Deterministic pseudo-random sleep per index, so items finish out of
	/// order.
	fn jitter(index: usize) {
		let micros = (index.wrapping_mul(2_654_435_761) >> 7) % 400;
		std::thread::sleep(Duration::from_micros(micros as u64));
	}

	#[test]
	fn results_arrive_in_index_order_under_random_durations() {
		for workers in [1, 2, 7] {
			let mut seen = Vec::new();
			let complete = ordered(
				300,
				workers,
				&Never,
				|| 0usize,
				|count, index| {
					*count += 1;
					jitter(index);
					index * 3
				},
				|index, value| {
					assert_eq!(value, index * 3);
					seen.push(index);
					Flow::Continue
				},
			);
			assert!(complete);
			assert_eq!(seen, (0..300).collect::<Vec<_>>(), "workers={workers}");
		}
	}

	#[test]
	fn consumer_stop_abandons_later_items() {
		let started = AtomicUsize::new(0);
		let mut consumed = Vec::new();
		let complete = ordered(
			10_000,
			4,
			&Never,
			|| (),
			|(), index| {
				started.fetch_add(1, Ordering::Relaxed);
				jitter(index);
				index
			},
			|index, _| {
				consumed.push(index);
				if index == 5 {
					Flow::Stop
				} else {
					Flow::Continue
				}
			},
		);
		assert!(!complete);
		assert_eq!(consumed, (0..=5).collect::<Vec<_>>());
		// Nothing past the window beyond the stop point was started.
		assert!(started.load(Ordering::Relaxed) <= 6 + 4 * WINDOW_PER_WORKER);
	}

	#[test]
	fn workers_stay_within_the_window_of_a_slow_consumer() {
		let max_ahead = AtomicUsize::new(0);
		let consumed = AtomicUsize::new(0);
		let workers = 3;
		let complete = ordered(
			400,
			workers,
			&Never,
			|| (),
			|(), index| {
				let ahead = index.saturating_sub(consumed.load(Ordering::SeqCst));
				max_ahead.fetch_max(ahead, Ordering::SeqCst);
			},
			|index, ()| {
				if index % 50 == 0 {
					std::thread::sleep(Duration::from_millis(2));
				}
				consumed.store(index + 1, Ordering::SeqCst);
				Flow::Continue
			},
		);
		assert!(complete);
		assert!(max_ahead.load(Ordering::SeqCst) <= workers * WINDOW_PER_WORKER);
	}

	#[test]
	fn stop_signal_ends_the_run() {
		let fired = AtomicBool::new(false);
		let stop = || fired.load(Ordering::Relaxed);
		let mut consumed = 0;
		let complete = ordered(
			100_000,
			4,
			&stop,
			|| (),
			|(), index| {
				if index == 50 {
					fired.store(true, Ordering::Relaxed);
				}
			},
			|_, ()| {
				consumed += 1;
				Flow::Continue
			},
		);
		assert!(!complete);
		assert!(consumed < 100_000);
	}
}
