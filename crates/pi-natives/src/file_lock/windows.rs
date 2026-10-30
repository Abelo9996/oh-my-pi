use std::{
	io,
	os::windows::io::{FromRawHandle, OwnedHandle},
	ptr,
};

use windows_sys::Win32::{
	Foundation::{
		ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GetLastError, SetLastError,
	},
	System::Threading::{CreateMutexExW, OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE},
};

/// Windows lease held by the exclusive lifetime of a named kernel object.
pub struct PlatformFileLock {
	handle: Option<OwnedHandle>,
}

fn wide_name(path: &str) -> Vec<u16> {
	format!(r"Global\{}", super::memory_lock_name(path))
		.encode_utf16()
		.chain(std::iter::once(0))
		.collect()
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let wide_name = wide_name(path);

	// The name's existence, not thread-affine mutex ownership, is the lease.
	// A handle can therefore be released from a different native worker thread.
	// Contenders see ERROR_ALREADY_EXISTS and immediately close their handle.
	// CreateMutexW requests MUTEX_ALL_ACCESS for an existing object. A lease
	// only needs a handle, so do not reject a contender allowed to synchronize
	// but not to modify the owner's security descriptor.
	// SAFETY: SetLastError(0) safely resets the thread-local error status before
	// the call.
	unsafe { SetLastError(0) };
	// SAFETY: the attributes pointer is null, and `wide_name` is a live,
	// NUL-terminated UTF-16 string for the duration of the call.
	let raw_handle =
		unsafe { CreateMutexExW(ptr::null(), wide_name.as_ptr(), 0, SYNCHRONIZATION_SYNCHRONIZE) };
	if raw_handle.is_null() {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `CreateMutexExW` returned a fresh owned handle. `OwnedHandle`
	// closes it exactly once on every return path.
	let handle = unsafe { OwnedHandle::from_raw_handle(raw_handle) };
	// SAFETY: this immediately observes the last-error value set by
	// `CreateMutexExW`; no intervening system call can overwrite it.
	if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
		return Ok(None);
	}
	Ok(Some(PlatformFileLock { handle: Some(handle) }))
}

/// Opening the existing object never creates one, so a missing name stays free
/// for a concurrent `try_acquire`. While open, the handle keeps a releasing
/// holder's object alive for an instant; acquirers retry briefly to cover that.
pub fn is_held(path: &str) -> io::Result<bool> {
	let wide_name = wide_name(path);
	// SAFETY: `wide_name` is a live, NUL-terminated UTF-16 string for the call.
	let raw_handle = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, wide_name.as_ptr()) };
	if !raw_handle.is_null() {
		// SAFETY: `OpenMutexW` returned a fresh owned handle; dropping closes it.
		drop(unsafe { OwnedHandle::from_raw_handle(raw_handle) });
		return Ok(true);
	}
	// SAFETY: this immediately observes the last-error value set by
	// `OpenMutexW`.
	match unsafe { GetLastError() } {
		ERROR_FILE_NOT_FOUND => Ok(false),
		// The object exists; its owner just denies us access.
		ERROR_ACCESS_DENIED => Ok(true),
		_ => Err(io::Error::last_os_error()),
	}
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.handle.take());
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use std::{
		thread,
		time::{SystemTime, UNIX_EPOCH},
	};

	use windows_sys::Win32::Security::{
		ACL_REVISION, AddAccessAllowedAce, InitializeAcl, SE_DACL_PRESENT, SECURITY_ATTRIBUTES,
		SECURITY_DESCRIPTOR, SECURITY_WORLD_SID_AUTHORITY, SID,
	};

	use super::*;

	fn restricted_mutex(path: &str, allowed_access: u32) -> OwnedHandle {
		let mut sid = SID {
			Revision:            1,
			SubAuthorityCount:   1,
			IdentifierAuthority: SECURITY_WORLD_SID_AUTHORITY,
			SubAuthority:        [0],
		};
		let mut acl_storage = [0_u32; 16];
		let acl = acl_storage.as_mut_ptr().cast();
		// SAFETY: storage is DWORD-aligned and has room for an ACL and one
		// allowed ACE containing the complete Everyone SID.
		unsafe {
			assert_ne!(InitializeAcl(acl, 64, ACL_REVISION), 0);
			assert_ne!(
				AddAccessAllowedAce(acl, ACL_REVISION, allowed_access, (&raw mut sid).cast()),
				0
			);
		}
		let mut descriptor = SECURITY_DESCRIPTOR {
			Revision: 1,
			Control: SE_DACL_PRESENT,
			Dacl: acl,
			..SECURITY_DESCRIPTOR::default()
		};
		let attributes = SECURITY_ATTRIBUTES {
			nLength:              size_of::<SECURITY_ATTRIBUTES>()
				.try_into()
				.expect("attributes size"),
			lpSecurityDescriptor: (&raw mut descriptor).cast(),
			bInheritHandle:       0,
		};
		let name = wide_name(path);
		// SAFETY: descriptor, ACL, SID, and NUL-terminated name all remain
		// valid for the call. Zero access is enough to hold the object's
		// lifetime.
		let handle = unsafe { CreateMutexExW(&raw const attributes, name.as_ptr(), 0, 0) };
		assert!(!handle.is_null(), "{}", io::Error::last_os_error());
		// SAFETY: the successful call returned one owned handle.
		unsafe { OwnedHandle::from_raw_handle(handle) }
	}

	#[test]
	fn limited_access_contender_observes_held_lease_and_can_acquire_after_release() {
		let path = format!("oauth-lock-limited-{}", std::process::id());
		let owner = restricted_mutex(&path, SYNCHRONIZATION_SYNCHRONIZE);
		assert!(
			try_acquire(&path)
				.expect("limited-access contention")
				.is_none()
		);
		drop(owner);
		let mut successor = try_acquire(&path)
			.expect("acquire after release")
			.expect("exclusive lease");
		successor.release().expect("release successor");
	}

	#[test]
	fn denied_access_is_not_treated_as_contention() {
		let path = format!("oauth-lock-denied-{}", std::process::id());
		let _owner = restricted_mutex(&path, 0);
		let Err(error) = try_acquire(&path) else {
			panic!("denied access must remain an error");
		};
		assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
	}

	#[test]
	fn probe_reports_an_owner_that_denies_access_as_held() {
		let path = format!("oauth-lock-probe-denied-{}", std::process::id());
		assert!(!is_held(&path).expect("probe free name"));
		let owner = restricted_mutex(&path, 0);
		assert!(is_held(&path).expect("probe denied owner"));
		drop(owner);
		assert!(!is_held(&path).expect("probe released name"));
	}

	#[test]
	fn releases_from_a_different_worker_thread() {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		let path = format!("oauth-lock-thread-{}-{nonce}", std::process::id());
		let mut lease = try_acquire(&path)
			.expect("acquire lease")
			.expect("exclusive lease");
		assert!(try_acquire(&path).expect("contend").is_none());
		thread::spawn(move || lease.release().expect("release on another worker"))
			.join()
			.expect("worker completed");
		let mut successor = try_acquire(&path)
			.expect("acquire successor")
			.expect("released lease");
		successor.release().expect("release successor");
	}
}
