//! Ordered parallel execution over a candidate stream.
//!
//! [`streamed`] runs `work` for every item a producer feeds, on several
//! threads, while the calling thread consumes results strictly in feed order,
//! so output is deterministic and a consumer can stop once it has what it
//! needs: workers claim items front to back, at most a bounded window ahead of
//! the consumed prefix, the producer pauses once it is far enough ahead of the
//! workers, and everything ends as soon as the consumer stops. [`ordered`] is
//! the same over the indices `0..len`.
//!
//! Used by searches that must report the first results in path order
//! (`grep` with a match budget, fed by a path-ordered walk that stops with
//! it; the shell's `rg`/`grep`, which write each file's output as soon as
//! every earlier file's output is written).
//!
//! ```ignore
//! let mut lines = Vec::new();
//! exec::ordered(files.len(), 4, &Never, Vec::new, |buf, i| search(buf, &files[i]), |_, out| {
//!     lines.extend(out);
//!     Flow::Continue
//! });
//! ```

use std::collections::VecDeque;

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

/// How many produced items may wait for a worker before the producer pauses,
/// per window slot.
const QUEUE_PER_SLOT: usize = 4;

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
	consume: C,
) -> bool
where
	S: Send,
	R: Send,
	I: Fn() -> S + Sync,
	W: Fn(&mut S, usize) -> R + Sync,
	C: FnMut(usize, R) -> Flow,
{
	let feed = |push: &mut dyn FnMut(usize) -> bool| {
		for index in 0..len {
			if !push(index) {
				return;
			}
		}
	};
	streamed(workers.min(len), stop, feed, init, |state, &index| work(state, index), consume)
}

/// Runs `work(state, &item)` for every item `produce` feeds through its push
/// callback.
///
/// `produce` runs on its own thread; `push` returns false once the run ended
/// (the consumer stopped, `stop` fired, or a thread panicked), and the
/// producer should then return. Work runs on up to `workers` threads (each
/// with its own `init()` state; `workers <= 1` runs everything inline on the
/// calling thread), and each item is handed back with its result to
/// `consume(item, result)` on the calling thread in feed order. Returns false
/// when `consume` or `stop` ended it early.
pub fn streamed<T, S, R, P, I, W, C>(
	workers: usize,
	stop: &dyn Stop,
	produce: P,
	init: I,
	work: W,
	mut consume: C,
) -> bool
where
	T: Send,
	S: Send,
	R: Send,
	P: FnOnce(&mut dyn FnMut(T) -> bool) + Send,
	I: Fn() -> S + Sync,
	W: Fn(&mut S, &T) -> R + Sync,
	C: FnMut(T, R) -> Flow,
{
	if workers <= 1 {
		return inline(stop, produce, &init, &work, &mut consume);
	}
	let window = workers * WINDOW_PER_WORKER;
	let shared = Shared {
		ring: Mutex::new(Ring {
			queue:     VecDeque::new(),
			slots:     (0..window).map(|_| None).collect(),
			consumed:  0,
			claimed:   0,
			produced:  0,
			closed:    false,
			abandoned: false,
		}),
		ready: Condvar::new(),
		work: Condvar::new(),
		room: Condvar::new(),
		window,
	};
	std::thread::scope(|scope| {
		scope.spawn(|| run_producer(&shared, stop, produce));
		for _ in 0..workers {
			scope.spawn(|| run_worker(&shared, stop, &init, &work));
		}
		// Releases waiting threads however consumption ends, a panicking
		// consumer included.
		let _abandon = Abandon { shared: &shared, always: true };
		consume_in_order(&shared, stop, &mut consume)
	})
}

/// [`streamed`] on the calling thread alone.
fn inline<T, S, R, P, I, W, C>(
	stop: &dyn Stop,
	produce: P,
	init: &I,
	work: &W,
	consume: &mut C,
) -> bool
where
	P: FnOnce(&mut dyn FnMut(T) -> bool),
	I: Fn() -> S,
	W: Fn(&mut S, &T) -> R,
	C: FnMut(T, R) -> Flow,
{
	let mut state = None;
	let mut complete = true;
	produce(&mut |item| {
		if stop.stop() {
			complete = false;
			return false;
		}
		let result = work(state.get_or_insert_with(init), &item);
		if consume(item, result) == Flow::Stop {
			complete = false;
			return false;
		}
		true
	});
	complete && !stop.stop()
}

/// State shared by the producer, the workers, and the consumer.
struct Ring<T, R> {
	/// Produced items no worker claimed yet, in feed order.
	queue:     VecDeque<T>,
	/// Slot `i % window` holds item `i` and its result once done, for
	/// `consumed <= i < consumed + window`.
	slots:     Vec<Option<(T, R)>>,
	/// Items handed to the consumer so far.
	consumed:  usize,
	/// Items claimed by workers so far (the next claim's index).
	claimed:   usize,
	/// Items fed so far.
	produced:  usize,
	/// The producer returned; nothing more will be fed.
	closed:    bool,
	/// The consumer stopped, `stop` fired, or a thread panicked.
	abandoned: bool,
}

struct Shared<T, R> {
	ring:   Mutex<Ring<T, R>>,
	/// Signalled when the item the consumer waits for is stored, or the feed
	/// closes.
	ready:  Condvar,
	/// Signalled when workers may have something to claim: an item was fed,
	/// the window moved, the feed closed, or the run was abandoned.
	work:   Condvar,
	/// Signalled when the producer may feed again: a worker claimed an item
	/// or the run was abandoned.
	room:   Condvar,
	window: usize,
}

impl<T, R> Shared<T, R> {
	fn abandon(&self, ring: &mut Ring<T, R>) {
		ring.abandoned = true;
		self.work.notify_all();
		self.room.notify_all();
		self.ready.notify_all();
	}
}

fn run_producer<T, R, P>(shared: &Shared<T, R>, stop: &dyn Stop, produce: P)
where
	P: FnOnce(&mut dyn FnMut(T) -> bool),
{
	let _guard = Abandon { shared, always: false };
	let cap = shared.window * QUEUE_PER_SLOT;
	produce(&mut |item| {
		let mut ring = shared.ring.lock();
		loop {
			if ring.abandoned {
				return false;
			}
			if stop.stop() {
				shared.abandon(&mut ring);
				return false;
			}
			if ring.queue.len() < cap {
				break;
			}
			shared.room.wait(&mut ring);
		}
		ring.queue.push_back(item);
		ring.produced += 1;
		drop(ring);
		shared.work.notify_one();
		true
	});
	let mut ring = shared.ring.lock();
	ring.closed = true;
	drop(ring);
	shared.work.notify_all();
	shared.ready.notify_all();
}

fn run_worker<T, S, R, I, W>(shared: &Shared<T, R>, stop: &dyn Stop, init: &I, work: &W)
where
	I: Fn() -> S,
	W: Fn(&mut S, &T) -> R,
{
	let _guard = Abandon { shared, always: false };
	let mut state = None;
	loop {
		let (index, item) = {
			let mut ring = shared.ring.lock();
			loop {
				if ring.abandoned {
					return;
				}
				if stop.stop() {
					shared.abandon(&mut ring);
					return;
				}
				if ring.claimed < ring.consumed + shared.window
					&& let Some(item) = ring.queue.pop_front()
				{
					ring.claimed += 1;
					shared.room.notify_one();
					break (ring.claimed - 1, item);
				}
				if ring.closed && ring.queue.is_empty() {
					return;
				}
				shared.work.wait(&mut ring);
			}
		};
		let result = work(state.get_or_insert_with(init), &item);
		let mut ring = shared.ring.lock();
		if ring.abandoned {
			return;
		}
		ring.slots[index % shared.window] = Some((item, result));
		let wanted = ring.consumed == index;
		drop(ring);
		if wanted {
			shared.ready.notify_one();
		}
	}
}

/// Abandons the run on drop (`always`) or when its thread panics, so no
/// thread waits for a result, an item, or room that will not come; the scope
/// re-raises any panic.
struct Abandon<'a, T, R> {
	shared: &'a Shared<T, R>,
	always: bool,
}

impl<T, R> Drop for Abandon<'_, T, R> {
	fn drop(&mut self) {
		if self.always || std::thread::panicking() {
			self.shared.abandon(&mut self.shared.ring.lock());
		}
	}
}

/// Hands results to `consume` in feed order; false when it stopped early.
fn consume_in_order<T, R, C>(shared: &Shared<T, R>, stop: &dyn Stop, consume: &mut C) -> bool
where
	C: FnMut(T, R) -> Flow,
{
	for index in 0.. {
		let (item, result) = {
			let mut ring = shared.ring.lock();
			loop {
				if let Some(done) = ring.slots[index % shared.window].take() {
					break done;
				}
				if ring.abandoned || stop.stop() {
					return false;
				}
				if ring.closed && index >= ring.produced {
					return true;
				}
				shared.ready.wait(&mut ring);
			}
		};
		if stop.stop() {
			return false;
		}
		shared.ring.lock().consumed = index + 1;
		shared.work.notify_all();
		if consume(item, result) == Flow::Stop {
			return false;
		}
	}
	unreachable!("a feed longer than usize::MAX items")
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

	/// A slow producer is consumed in feed order as items arrive, and a
	/// consumer stop ends the producer within its backpressure bound.
	#[test]
	fn streamed_follows_a_slow_producer_and_stops_it() {
		let fed = AtomicUsize::new(0);
		let mut seen = Vec::new();
		let complete = streamed(
			4,
			&Never,
			|push: &mut dyn FnMut(usize) -> bool| {
				for item in 0..100_000 {
					if item % 64 == 0 {
						std::thread::sleep(Duration::from_micros(200));
					}
					fed.fetch_add(1, Ordering::Relaxed);
					if !push(item) {
						return;
					}
				}
			},
			|| (),
			|(), &item| {
				jitter(item);
				item + 1
			},
			|item, result| {
				assert_eq!(result, item + 1);
				seen.push(item);
				if item == 300 {
					Flow::Stop
				} else {
					Flow::Continue
				}
			},
		);
		assert!(!complete);
		assert_eq!(seen, (0..=300).collect::<Vec<_>>());
		let window = 4 * WINDOW_PER_WORKER;
		assert!(fed.load(Ordering::Relaxed) <= 301 + window + window * QUEUE_PER_SLOT + 1);
	}

	/// An empty feed completes without waiting.
	#[test]
	fn streamed_empty_feed_completes() {
		for workers in [1, 4] {
			let complete = streamed(
				workers,
				&Never,
				|_: &mut dyn FnMut(usize) -> bool| {},
				|| (),
				|(), _| (),
				|_, ()| Flow::Continue,
			);
			assert!(complete);
		}
	}
}
