# Cloudflare Vault Backup

Cloudflare Vault Backup backs up your Obsidian vault to your own Cloudflare R2 bucket as versioned snapshots, with per-note restore and optional client-side encryption. It is a one-way backup tool, not a two-way sync, and it complements Obsidian File Recovery and Obsidian Sync rather than replacing them.

Your local vault is always the source of truth. The plugin never changes local files during a backup, so deletions cannot come back from the bucket and two devices cannot overwrite each other's edits.

## Before you install

- **Account required.** You need a Cloudflare account with R2 enabled. The plugin stores your backups in an R2 bucket that you own.
- **Payment may be required.** The plugin is free. Cloudflare bills R2 storage and requests beyond its monthly free tier, and it may ask for a payment method before it turns on R2. See [Retention and cost](#retention-and-cost).
- **Network use.** The plugin connects only to your bucket's R2 endpoint, to upload, list, download, and delete backup data. It has no telemetry. See [Network use and privacy](#network-use-and-privacy).
- **Files outside the vault.** The plugin never reads or writes files outside your vault.

## How it works

Each backup creates a snapshot. A snapshot is one JSON manifest that maps every file path to a SHA-256 hash, a size, and a modification time. File contents live in separate blobs named by their hash.

Because blobs are content-addressed, a file that did not change between snapshots is stored once. A backup uploads only blobs the bucket does not already have. After a one-note edit, a backup uploads one blob and one manifest. Any snapshot can be restored as it was at that point in time.

A backup first compares the size and modification time of every file with a local index. If nothing changed, the backup skips the lock and the upload and creates no snapshot.

The bucket layout under your prefix looks like this:

```
<prefix>/<vaultId>/vault.json                 backup set descriptor
<prefix>/<vaultId>/lock.json                  run lock
<prefix>/<vaultId>/snapshots/<snapId>.json    one manifest per snapshot
<prefix>/<vaultId>/blobs/<h0h1>/<hash>        file contents
```

- `vaultId` is 16 random hex characters, created on first load and saved in the plugin settings. Renaming the vault folder does not orphan the backups.
- `snapId` looks like `20261016T162233Z-3fa9`. Snapshot ids sort in time order.
- Vault paths never appear in object keys. Paths appear only inside manifests.

A backup holds `lock.json` for the whole run. The plugin creates the lock with a conditional write, refreshes it every 60 seconds, and treats it as expired 10 minutes after the last refresh. If another device holds a live lock, the backup fails with a "locked" error and the next scheduled run tries again. A lock left behind by this device, for example when Obsidian quit mid-backup, is taken over on the next run. The lock stops one device's cleanup from deleting a blob that another device is about to reference.

Retention decides which snapshots to keep. Pruning deletes the manifests of the other snapshots, then deletes blobs that no kept manifest references. A blob is deleted only if it is older than the grace period (24 hours by default). The grace period protects blobs that a backup in progress has uploaded but not yet committed. Pruning runs after a backup at most once per garbage collection interval (24 hours by default), or when you run **Prune old snapshots now**.

## Network use and privacy

The plugin connects to one host, `https://<account-id>.r2.cloudflarestorage.com`, using the R2 credentials you supply. It sends only these things to your bucket:

- The contents of the files it backs up.
- File paths, sizes, modification times, and hashes, inside each manifest.
- The vault name and the creation time, inside `vault.json`.
- A random device id, inside each manifest.

The plugin has no telemetry. It calls no third-party service and no Cloudflare API other than the R2 S3 endpoint. Network requests happen only when a backup, restore, prune, connection test, or usage estimate runs.

The access key ID, the secret access key, and the encryption passphrase are stored in Obsidian's secret storage. The plugin's `data.json` file holds only the names of those secrets, never their values.

With encryption off, everything in the bucket is plaintext. Blobs are the raw file contents. Manifests list every file name and path in the vault. Anyone with read access to the bucket can read your notes.

With encryption on, blobs and manifests are encrypted before they leave the device. Some facts stay visible to anyone who can list the bucket:

- Object sizes.
- Snapshot times, because they are part of each snapshot id.
- The number of blobs, which roughly tracks the number of distinct files.
- The vault name, the encryption salt, and the iteration count in `vault.json`, which is never encrypted.

## Installation

Cloudflare Vault Backup needs Obsidian 1.11.4 or later on desktop or mobile.

### From Community plugins

1. In Obsidian, open **Settings → Community plugins**.
2. If restricted mode is on, select **Turn on community plugins**.
3. Select **Browse**, then search for **Cloudflare Vault Backup**.
4. Select **Install**, then **Enable**.

### With BRAT

Use [BRAT](https://github.com/TfTHacker/obsidian42-brat) to install the plugin before it appears in Community plugins, or to get updates from GitHub as soon as they are released.

1. Install and enable **BRAT** from **Settings → Community plugins**.
2. Run the **BRAT: Add a beta plugin for testing** command.
3. Enter `https://github.com/bapspatil/cloudflare-vault-backup` and select **Add plugin**.
4. Enable **Cloudflare Vault Backup** in **Settings → Community plugins**.

### Manually

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/bapspatil/cloudflare-vault-backup/releases/latest).
2. In your vault, create the folder `<Vault>/.obsidian/plugins/cloudflare-vault-backup/`. If you changed the configuration folder, use that folder instead of `.obsidian`.
3. Copy the three files into that folder.
4. Reload Obsidian, then enable **Cloudflare Vault Backup** in **Settings → Community plugins**.

To update a manual install, replace the three files with the ones from the newer release and reload Obsidian.

### Upgrading from 1.1.0 or earlier

Versions 1.1.0 and earlier were named R2 Vault Sync and used the plugin ID `r2-vault-sync`. From 1.2.1 the plugin is named Cloudflare Vault Backup and the ID is `cloudflare-vault-backup`, so Obsidian treats the new version as a separate plugin in a new folder. Install the new version, enable it, and it copies your settings from the old folder, so it keeps backing up to the same backup set. Then uninstall the old copy. Your secrets stay in Obsidian's secret storage, so you don't need to enter them again.

### Updating

Update the plugin on every device that backs up to the same backup set at the same time. Newer versions can read backups made by older versions, but an older version cannot always read backups made by a newer one. An older version that cannot read a snapshot fails with an error and changes nothing.

## Setup

You need a Cloudflare account with R2 enabled. The plugin needs Obsidian 1.11.4 or later because it stores your credentials in Obsidian's secret storage.

1. In the Cloudflare dashboard, go to **R2 object storage** and create a bucket.
2. In Obsidian, open **Settings → Cloudflare Vault Backup**.
3. Under **Connection**, select **Create token in Cloudflare**. This opens the Cloudflare dashboard with the R2 read and write permission pre-selected. Create an account API token scoped to the bucket you created, then copy the **Access Key ID** and the **Secret Access Key**. Cloudflare shows the secret once. You can also create the token manually in the dashboard under **R2 → Manage API tokens**.
4. Enter your account ID (32 hex characters, from the R2 overview page), the bucket name, and a prefix. The default prefix is `obsidian`. One bucket can hold several vaults under one prefix.
5. Add the access key ID and the secret access key in their secret fields.
6. Select **Test connection**.

The connection test writes a small probe object under `<prefix>/<vaultId>/`, reads it back, and deletes it. Success shows `Write OK, Read OK, Delete OK`.

You type the bucket name because a token scoped to one bucket cannot list buckets.

## Backing up

You can start a backup in three ways:

- Run the **Back up now** command.
- Select the **Back up vault to R2** ribbon icon (a cloud with an up arrow).
- Select the status bar item on desktop.

Scheduled backups run every hour by default. **Backup interval** offers off, 15 minutes, 30 minutes, and 1, 3, 6, 12, or 24 hours. A scheduled backup waits until you have stopped editing for the quiet period, which is 90 seconds by default. Turn on **Back up on startup** to run a backup 30 seconds after the workspace loads.

By default a backup includes every note and attachment in the vault and the configuration folder (`.obsidian` unless you changed it). The configuration folder holds your plugins, themes, and snippets. These files are always skipped:

- `workspace.json` and `workspace-mobile.json` in the configuration folder.
- This plugin's own `data.json`, `index.json`, `log.json`, and `counters.json`.

Folders that start with a dot, such as `.trash` and `.git`, are not scanned. Turn off **Include configuration folder** to skip the configuration folder entirely.

**Exclude patterns** takes one glob per line, such as `Templates/**` or `*.pdf`. A pattern without a slash also matches the file name in any folder.

Files larger than the size cap are skipped and listed in the snapshot as too large. The cap is 50 MB on desktop and 20 MB on mobile. You can change both under **What to back up**.

On desktop, the status bar shows the current state of a backup. On every platform, **Settings → Cloudflare Vault Backup → Backup log → View log** lists the last 100 runs with their result, the number and size of uploaded files, and any error.

## Restoring

Run **Open restore browser** to open the restore panel in the right sidebar. Pick a snapshot from the list, then browse its folders or filter by name.

For a single file you can:

- **Diff** a text file against the current version in your vault. Lines marked `-` are in the vault now, and lines marked `+` come from the snapshot. Diffs work for text files up to 1 MB, such as `.md`, `.canvas`, `.json`, and `.css`.
- **Restore as copy**, which writes the snapshot version next to the original. `Notes/a.md` becomes `Notes/a (restored 2026-10-16).md`.
- **Overwrite**, which replaces the file in your vault after you confirm.

**Restore whole snapshot** offers two choices:

- **Restore into `Restored/<snapId>`** writes every file of the snapshot under that folder and leaves your vault untouched.
- **Overwrite in place** replaces vault files with their snapshot versions. You type `restore` to confirm, and the plugin takes a backup first so you can undo it.

A restore skips any file whose current contents already match the snapshot. Every download is checked against its hash before the plugin writes it. A restore never deletes files.

Restoring into the configuration folder needs an extra confirmation, because that folder can contain plugin code that Obsidian runs the next time it starts. Restore configuration files only from a snapshot you trust. After a configuration restore the plugin reminds you to reload Obsidian. Workspace files and the plugin's own `data.json`, `index.json`, `log.json`, and `counters.json` are never restored. Paths outside this device's configuration folder that contain a name starting with a dot, such as `.git/hooks/pre-commit` or the configuration folder of a device that uses a different one, are never restored either. Neither is any path with a `~` followed by a digit in a file or folder name, such as `GIT~1/hooks/pre-commit`, because Windows can resolve such a name to a hidden folder. Rename those files before you back them up if you may need to restore them.

## Encryption

Encryption is optional and off by default. Turn it on with **Encrypt backups**, then add a passphrase.

The plugin derives keys from the passphrase with PBKDF2-SHA256 at 600,000 iterations and a random 16-byte salt. It encrypts every blob and manifest with AES-GCM and a random IV per object. Each encrypted object is bound to its role and name, so an object copied to another key in the bucket fails to decrypt instead of being read as something else. Blob names are an HMAC-SHA256 of the contents, so someone holding the bucket cannot confirm that it contains a file they already have.

If you lose the passphrase, nobody can read the backup. Cloudflare cannot recover it, and neither can the plugin. Keep a copy of the passphrase outside the vault.

The first backup records whether a backup set is encrypted. Switching encryption on or off for an existing backup set fails with an error. To switch, change the prefix so the plugin starts a new backup set. The next backup then uploads every file to the new set.

Encrypted blobs and manifests are unreadable in the R2 dashboard. You can restore them only through the plugin.

## Retention and cost

Retention keeps the union of these sets of snapshots:

| Setting | Default | Keeps |
| --- | --- | --- |
| **Keep latest** | 10 | The most recent snapshots |
| **Keep daily** | 7 | The newest snapshot of each of the last days that have one |
| **Keep weekly** | 4 | The newest snapshot of each ISO week |
| **Keep monthly** | 6 | The newest snapshot of each month |
| **Grace period before deleting unreferenced data (hours)** | 24 | Unreferenced blobs younger than this |
| **Garbage collection interval (hours)** | 24 | Minimum time between automatic prunes |

The newest snapshot is always kept. If all four keep settings are 0, every snapshot is kept.

**Usage and cost** in the settings shows an estimate for the current month. Stored data is the total size of the unique blobs referenced by all snapshots. Operations are the class A and class B requests this device has made this month, scaled to the full month. The estimate subtracts the free tier and prices the rest.

The prices in the plugin are as of 2026-10-16:

| Item | Price | Free each month |
| --- | --- | --- |
| Storage | $0.015 per GB-month | 10 GB-month |
| Class A operations (writes, lists) | $4.50 per million | 1 million |
| Class B operations (reads) | $0.36 per million | 10 million |

Check current prices on the [Cloudflare R2 pricing page](https://developers.cloudflare.com/r2/pricing/). The free tier applies to your whole Cloudflare account. Other buckets and other devices use the same allowance, so the estimate can show $0.00 while your bill does not.

## Mobile

The plugin works on iOS and Android. It uses only Obsidian and web APIs, with no Node or Electron APIs.

On mobile:

- Scheduled backups run only while Obsidian is open in the foreground. The operating system pauses timers when the app is in the background.
- The default size cap is 20 MB, because the plugin holds each file in memory while it hashes and uploads it.
- Uploads run two at a time instead of four.
- The status bar is not shown. Use the command, the ribbon icon, or the backup log.

## Limitations

- Backup is one-way. The plugin never pulls changes from the bucket on its own.
- A restore never deletes local files. Files created after a snapshot stay in place when you restore that snapshot.
- Files over the size cap are skipped.
- Backups run only while Obsidian is open.
- Devices that share a `vaultId` write snapshots into the same backup set, and the snapshots interleave. This happens when another tool, such as Obsidian Sync, syncs the plugin's `data.json` between devices. Each manifest records the device id that wrote it.

## Development

This project uses [Bun](https://bun.sh) to run the scripts in `package.json`.

```bash
bun install
bun run dev        # build in watch mode
bun run build      # type check and production build
bun run test       # unit tests
bun run lint
```

The integration tests run against a real R2 bucket. Create a `.env` file in the repository root:

```
R2_ACCOUNT_ID=<32 character account id>
R2_BUCKET=<bucket name>
R2_KEY_ID=<access key id>
R2_SECRET=<secret access key>
```

Then run `bun run test:int`. The `.env` file is ignored by git.

To test a local build in a vault, run `bun run build` and copy `main.js`, `manifest.json`, and `styles.css` to `<Vault>/.obsidian/plugins/cloudflare-vault-backup/`. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Author

Cloudflare Vault Backup is made by [Bapusaheb Patil](https://bapspatil.com). Report bugs and request features on [GitHub issues](https://github.com/bapspatil/cloudflare-vault-backup/issues).

## License

Cloudflare Vault Backup is released under the 0BSD license. See [LICENSE](LICENSE).
