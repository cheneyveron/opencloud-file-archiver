# web-app-file-archiver

OpenCloud Web extension for archive actions.

It registers context-menu actions for:

- Creating ZIP, encrypted ZIP and tar.gz archives into a selected folder
- Downloading ZIP, encrypted ZIP and tar.gz archives directly
- Extracting supported archive files into a selected folder
- Browsing supported archive files, previewing text/image/PDF entries and extracting selected entries
- Displaying archive job progress and cancellation in the runtime snackbar area

The extension talks to the companion `file-archiver-service` through `/archive` by default.
Override the service path with the app config property `fileArchiverServiceUrl`.

This app requires the core web patches in `../core-web-patches` unless those
capabilities already exist in the target OpenCloud Web version.
