//! Durable bundle storage under the provisioned office root.
//!
//! Every path is derived from server-generated UUIDs; display names, object
//! keys and client run ids never become filesystem components. The root must
//! already exist and carry a `.flatline-backup-storage` marker containing a
//! provisioned UUID — a missing marker is an unavailable storage, never a
//! reason to create a new tree under the application data directory.
//!
//! Chunks are appended and fsynced before the committed offset advances in
//! SQLite. A crash can therefore leave an uncommitted tail; reconciliation
//! truncates it back to the ledger.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Maximum chunk body and the upload chunk size.
pub const CHUNK_BYTES: u64 = 8 * 1024 * 1024;

/// Free space that must remain on the office mirror.
pub const RESERVE_BYTES: u64 = 100 * 1024 * 1024 * 1024;

/// Marker file that proves a root was provisioned for backup storage.
pub const STORAGE_MARKER: &str = ".flatline-backup-storage";

/// In-progress bundle name.
pub const PARTIAL_NAME: &str = "bundle.partial";

/// Published bundle name.
pub const FINAL_NAME: &str = "bundle.age";

/// Injectable free-space reading. Production uses the filesystem; tests use
/// a deterministic value so capacity arithmetic is exact.
pub trait FreeSpace: Send + Sync {
    fn available(&self, root: &Path) -> io::Result<u64>;
}

#[derive(Debug, Default)]
pub struct SystemFreeSpace;

impl FreeSpace for SystemFreeSpace {
    fn available(&self, root: &Path) -> io::Result<u64> {
        fs4::available_space(root)
    }
}

/// Failpoints used to prove crash recovery. Production injects nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    /// Chunk bytes are written but not yet fsynced.
    AfterAppend,
    /// Chunk is fsynced but the SQLite ledger has not advanced.
    AfterFsync,
    /// Ledger advanced; the HTTP response is lost.
    AfterDbUpdate,
    /// Finalization is ready to rename the partial bundle.
    BeforeRename,
    /// The bundle is published but the run is not marked completed.
    AfterRename,
}

pub trait FaultInjector: Send + Sync {
    fn hit(&self, point: FaultPoint) -> io::Result<()>;
}

#[derive(Debug, Default)]
pub struct NoFaults;

impl FaultInjector for NoFaults {
    fn hit(&self, _point: FaultPoint) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug)]
pub enum StorageError {
    /// Storage is not configured or its marker is missing/changed.
    Unavailable(String),
    /// Content does not match the declared size or digest.
    Mismatch(String),
    Io(io::Error),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::Unavailable(message) => formatter.write_str(message),
            StorageError::Mismatch(message) => formatter.write_str(message),
            StorageError::Io(error) => formatter.write_str(&error.to_string()),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<io::Error> for StorageError {
    fn from(error: io::Error) -> Self {
        StorageError::Io(error)
    }
}

/// A validated storage root.
#[derive(Clone)]
pub struct Storage {
    root: PathBuf,
    provisioned: String,
    free: Arc<dyn FreeSpace>,
    faults: Arc<dyn FaultInjector>,
}

impl Storage {
    /// Open a provisioned root with production hooks.
    pub fn open(root: &Path) -> Result<Self, StorageError> {
        Self::open_with(root, Arc::new(SystemFreeSpace), Arc::new(NoFaults))
    }

    pub fn open_with(
        root: &Path,
        free: Arc<dyn FreeSpace>,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<Self, StorageError> {
        let metadata = fs::symlink_metadata(root).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => {
                StorageError::Unavailable("backup storage root does not exist".to_string())
            }
            _ => StorageError::Io(error),
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(StorageError::Unavailable(
                "backup storage root must be a real directory".to_string(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(StorageError::Unavailable(
                    "backup storage root must be mode 0700".to_string(),
                ));
            }
        }

        let marker =
            fs::read_to_string(root.join(STORAGE_MARKER)).map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => StorageError::Unavailable(
                    "backup storage marker is missing; storage is not provisioned".to_string(),
                ),
                _ => StorageError::Io(error),
            })?;
        let provisioned = Uuid::parse_str(marker.trim()).map_err(|_| {
            StorageError::Unavailable("backup storage marker is not a UUID".to_string())
        })?;

        Ok(Self {
            root: root.to_path_buf(),
            provisioned: provisioned.to_string(),
            free,
            faults,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The provisioned UUID from the marker, used for cross-restart pinning.
    pub fn provisioned_id(&self) -> &str {
        &self.provisioned
    }

    /// Re-read the marker before a mutation; a replaced mount must not be
    /// treated as the same storage.
    pub fn verify_root(&self) -> Result<(), StorageError> {
        let metadata = fs::symlink_metadata(&self.root).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => {
                StorageError::Unavailable("backup storage root disappeared".to_string())
            }
            _ => StorageError::Io(error),
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(StorageError::Unavailable(
                "backup storage root must be a real directory".to_string(),
            ));
        }

        let marker =
            fs::read_to_string(self.root.join(STORAGE_MARKER)).map_err(|error| {
                match error.kind() {
                    io::ErrorKind::NotFound => {
                        StorageError::Unavailable("backup storage marker disappeared".to_string())
                    }
                    _ => StorageError::Io(error),
                }
            })?;
        let current = Uuid::parse_str(marker.trim()).map_err(|_| {
            StorageError::Unavailable("backup storage marker is not a UUID".to_string())
        })?;
        if current.to_string() != self.provisioned {
            return Err(StorageError::Unavailable(
                "backup storage marker changed".to_string(),
            ));
        }
        Ok(())
    }

    pub fn available_bytes(&self) -> Result<u64, StorageError> {
        self.verify_root()?;
        self.free.available(&self.root).map_err(StorageError::Io)
    }

    pub fn agent_dir(&self, agent_id: &str) -> Result<PathBuf, StorageError> {
        let agent = parse_uuid(agent_id)?;
        Ok(self.root.join("agents").join(agent))
    }

    pub fn run_dir(&self, agent_id: &str, run_id: &str) -> Result<PathBuf, StorageError> {
        let run = parse_uuid(run_id)?;
        Ok(self.agent_dir(agent_id)?.join(run))
    }

    pub fn partial_path(&self, agent_id: &str, run_id: &str) -> Result<PathBuf, StorageError> {
        Ok(self.run_dir(agent_id, run_id)?.join(PARTIAL_NAME))
    }

    pub fn final_path(&self, agent_id: &str, run_id: &str) -> Result<PathBuf, StorageError> {
        Ok(self.run_dir(agent_id, run_id)?.join(FINAL_NAME))
    }

    /// Create (or verify) the run directory and its empty partial file.
    pub fn prepare_run(&self, agent_id: &str, run_id: &str) -> Result<(), StorageError> {
        self.verify_root()?;
        let run_dir = self.run_dir(agent_id, run_id)?;
        ensure_directory(&self.root.join("agents"))?;
        ensure_directory(&self.agent_dir(agent_id)?)?;
        ensure_directory(&run_dir)?;
        ensure_regular(&run_dir.join(PARTIAL_NAME), true)?;
        sync_directory(&run_dir)?;
        sync_directory(&self.agent_dir(agent_id)?)?;
        sync_directory(&self.root.join("agents"))?;
        sync_directory(&self.root)?;
        Ok(())
    }

    /// Remove the bytes of a run (used when reopening an expired run).
    pub fn reset_run(&self, agent_id: &str, run_id: &str) -> Result<(), StorageError> {
        self.verify_root()?;
        let run_dir = self.run_dir(agent_id, run_id)?;
        remove_regular(&run_dir.join(PARTIAL_NAME))?;
        remove_regular(&run_dir.join(FINAL_NAME))?;
        ensure_directory(&run_dir)?;
        ensure_regular(&run_dir.join(PARTIAL_NAME), true)?;
        sync_directory(&run_dir)?;
        sync_directory(&self.agent_dir(agent_id)?)?;
        sync_directory(&self.root.join("agents"))?;
        sync_directory(&self.root)?;
        Ok(())
    }

    /// Append one verified chunk at the committed offset and fsync.
    ///
    /// The file may already be longer than `offset` after a crash; the
    /// uncommitted tail is discarded before appending.
    pub fn append_chunk(
        &self,
        agent_id: &str,
        run_id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<u64, StorageError> {
        self.verify_root()?;
        let path = self.partial_path(agent_id, run_id)?;
        ensure_regular(&path, offset == 0)?;

        let mut file = OpenOptions::new().read(true).write(true).open(&path)?;
        let length = file.metadata()?.len();
        if length < offset {
            return Err(StorageError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "bundle file is shorter than the committed offset",
            )));
        }
        if length > offset {
            file.set_len(offset)?;
            file.seek(SeekFrom::Start(offset))?;
        } else {
            file.seek(SeekFrom::End(0))?;
        }

        file.write_all(bytes)?;
        self.faults
            .hit(FaultPoint::AfterAppend)
            .map_err(StorageError::Io)?;
        file.sync_all()?;
        self.faults
            .hit(FaultPoint::AfterFsync)
            .map_err(StorageError::Io)?;
        Ok(offset + bytes.len() as u64)
    }

    /// Truncate an uploading bundle to its committed offset after a restart.
    pub fn truncate_to_committed(
        &self,
        agent_id: &str,
        run_id: &str,
        committed: u64,
    ) -> Result<(), StorageError> {
        self.verify_root()?;
        let path = self.partial_path(agent_id, run_id)?;
        ensure_regular(&path, committed == 0)?;
        let file = OpenOptions::new().write(true).open(&path)?;
        let length = file.metadata()?.len();
        if length < committed {
            return Err(StorageError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "bundle file is shorter than the committed offset",
            )));
        }
        if length > committed {
            file.set_len(committed)?;
            file.sync_all()?;
        }
        Ok(())
    }

    /// Metadata of the published bundle, without hashing it. Used for
    /// streamed downloads.
    pub fn final_metadata(
        &self,
        agent_id: &str,
        run_id: &str,
    ) -> Result<(PathBuf, u64), StorageError> {
        self.verify_root()?;
        let path = self.final_path(agent_id, run_id)?;
        ensure_regular(&path, false)?;
        let metadata = fs::symlink_metadata(&path)?;
        Ok((path, metadata.len()))
    }

    /// Verify the published bundle.
    pub fn verify_final(
        &self,
        agent_id: &str,
        run_id: &str,
        total: u64,
        sha256: &str,
    ) -> Result<(), StorageError> {
        self.verify_root()?;
        let path = self.final_path(agent_id, run_id)?;
        ensure_regular(&path, false)?;
        let (size, digest) = hash_file(&path)?;
        if size != total {
            return Err(StorageError::Mismatch(format!(
                "published bundle is {size} bytes, expected {total}"
            )));
        }
        if digest != sha256 {
            return Err(StorageError::Mismatch(
                "published bundle sha256 does not match".to_string(),
            ));
        }
        Ok(())
    }

    /// Stream-check the partial bundle, fsync, atomically publish it, and
    /// fsync the containing directory.
    pub fn finalize(
        &self,
        agent_id: &str,
        run_id: &str,
        total: u64,
        sha256: &str,
    ) -> Result<(), StorageError> {
        self.verify_root()?;
        let run_dir = self.run_dir(agent_id, run_id)?;
        let partial = run_dir.join(PARTIAL_NAME);
        let final_path = run_dir.join(FINAL_NAME);

        // A published file may already exist after a crash between rename and
        // the SQLite update: verify it, drop any leftover partial, and finish.
        match fs::symlink_metadata(&final_path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(StorageError::Io(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "published bundle path is not a regular file",
                    )));
                }
                remove_regular(&partial)?;
                sync_directory(&run_dir)?;
                sync_directory(&self.agent_dir(agent_id)?)?;
                return self.verify_final(agent_id, run_id, total, sha256);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(StorageError::Io(error)),
        }

        ensure_regular(&partial, false)?;
        let (size, digest) = hash_file(&partial)?;
        if size != total {
            return Err(StorageError::Mismatch(format!(
                "bundle is {size} bytes, expected {total}"
            )));
        }
        if digest != sha256 {
            return Err(StorageError::Mismatch(
                "bundle sha256 does not match".to_string(),
            ));
        }

        let file = OpenOptions::new().read(true).open(&partial)?;
        file.sync_all()?;
        drop(file);

        self.faults
            .hit(FaultPoint::BeforeRename)
            .map_err(StorageError::Io)?;
        fs::rename(&partial, &final_path)?;
        sync_directory(&run_dir)?;
        sync_directory(&self.agent_dir(agent_id)?)?;
        self.faults
            .hit(FaultPoint::AfterRename)
            .map_err(StorageError::Io)?;

        self.verify_final(agent_id, run_id, total, sha256)
    }

    /// Remove a run's files; errors removing absent files are ignored.
    pub fn delete_run(&self, agent_id: &str, run_id: &str) -> Result<(), StorageError> {
        self.verify_root()?;
        let run_dir = self.run_dir(agent_id, run_id)?;
        remove_regular(&run_dir.join(PARTIAL_NAME))?;
        remove_regular(&run_dir.join(FINAL_NAME))?;
        match fs::remove_dir(&run_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(StorageError::Io(error)),
        }
        sync_directory_if_exists(&self.agent_dir(agent_id)?)?;
        Ok(())
    }

    pub fn fault(&self, point: FaultPoint) -> Result<(), StorageError> {
        self.faults.hit(point).map_err(StorageError::Io)
    }
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn sync_directory_if_exists(path: &Path) -> io::Result<()> {
    match sync_directory(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn parse_uuid(value: &str) -> Result<String, StorageError> {
    Uuid::parse_str(value)
        .map(|uuid| uuid.to_string())
        .map_err(|_| {
            StorageError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "storage identifiers must be UUIDs",
            ))
        })
}

fn ensure_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "storage path is not a real directory",
                ))
            } else {
                Ok(())
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
            }
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn ensure_regular(path: &Path, create: bool) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "storage file is not a regular file",
                ))
            } else {
                Ok(())
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && create => OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(|_| ()),
        Err(error) => Err(error),
    }
}

fn remove_regular(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "refusing to remove a non-regular storage entry",
                ))
            } else {
                fs::remove_file(path)
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Streaming SHA-256 and byte count for a file, used by finalization and
/// recovery. Never loads the bundle into memory.
pub fn hash_file(path: &Path) -> io::Result<(u64, String)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((total, hex::encode(hasher.finalize())))
}
