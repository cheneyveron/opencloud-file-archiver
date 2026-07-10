# web-app-file-archiver

OpenCloud Web extension for archive actions.

It registers context-menu actions for:

- Creating ZIP, encrypted ZIP and tar.gz archives into a selected folder
- Downloading ZIP, encrypted ZIP and tar.gz archives directly
- Extracting supported archive files into a selected folder
- Browsing supported archive files, previewing text/image/PDF entries and extracting selected entries
- Displaying archive job progress and cancellation in the runtime snackbar area, or in a
  floating task panel when that runtime extension point is unavailable

The extension talks to the companion `file-archiver-service` through `/archive` by default.
Override the service path with the app config property `fileArchiverServiceUrl`.
The backend service is required; install the matching frontend ZIP and backend image together by
following [INSTALL.md](../INSTALL.md).

This app does not require the core web patches in `../core-web-patches`. It stays compatible
with older OpenCloud Web builds by:

- registering flat archive actions by default instead of relying on context action `children`
- prompting for the archive file name itself if the location picker does not return `fileName`
- using a floating task panel when `app.runtime.snackbars` is unavailable

If the target OpenCloud Web build supports context action `children`, set
`fileArchiverUseNestedActions: true` in the app config to use nested archive menus.
