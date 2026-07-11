// Command package-web creates and safely extracts the release ZIP for the
// OpenCloud file-archiver web app. It only uses the Go standard library so the
// acceptance script can run it with the same pinned Go toolchain as the backend.
package main

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	appDirectory               = "file-archiver"
	backendInstallationURL     = "https://github.com/cheneyveron/opencloud-file-archiver/blob/main/INSTALL.md"
	requiredBackendDescription = "Requires the companion file-archiver backend service. Install it before using this extension: " + backendInstallationURL
	maxArchiveEntries          = 100_000
	maxUncompressedZIP         = int64(1 << 30)
)

type manifest struct {
	Entrypoint          string `json:"entrypoint"`
	Description         string `json:"description"`
	RequiresBackend     bool   `json:"requiresBackend"`
	BackendInstallation string `json:"backendInstallation"`
}

func main() {
	if len(os.Args) != 4 {
		fatalf("usage: package-web <create|extract> <source> <destination>")
	}

	var err error
	switch os.Args[1] {
	case "create":
		err = createArchive(os.Args[2], os.Args[3])
	case "extract":
		err = extractArchive(os.Args[2], os.Args[3])
	default:
		err = fmt.Errorf("unknown operation %q", os.Args[1])
	}
	if err != nil {
		fatalf("%v", err)
	}
}

func createArchive(source, destination string) (returnErr error) {
	source, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	if err := validateAppDirectory(source); err != nil {
		return fmt.Errorf("invalid web dist: %w", err)
	}

	var paths []string
	err = filepath.WalkDir(source, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == source {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink is not allowed in release ZIP: %s", current)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported file type in release ZIP: %s", current)
		}
		paths = append(paths, current)
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(paths)

	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".file-archiver-*.zip")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer func() {
		if returnErr != nil {
			_ = os.Remove(temporaryName)
		}
	}()

	archive := zip.NewWriter(temporary)
	if err := writeDirectoryHeader(archive, appDirectory+"/"); err != nil {
		_ = archive.Close()
		_ = temporary.Close()
		return err
	}
	for _, current := range paths {
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		name := path.Join(appDirectory, filepath.ToSlash(relative))
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.IsDir() {
			if err := writeDirectoryHeader(archive, name+"/"); err != nil {
				return err
			}
			continue
		}
		if err := writeFile(archive, current, name); err != nil {
			return err
		}
	}
	if err := archive.Close(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temporaryName, 0o644); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, destination); err != nil {
		return err
	}
	return nil
}

func writeDirectoryHeader(archive *zip.Writer, name string) error {
	header := &zip.FileHeader{Name: name, Method: zip.Store}
	header.SetMode(0o755 | os.ModeDir)
	header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
	_, err := archive.CreateHeader(header)
	return err
}

func writeFile(archive *zip.Writer, source, name string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()

	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetMode(0o644)
	header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
	output, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	return err
}

func extractArchive(source, destination string) error {
	reader, err := zip.OpenReader(source)
	if err != nil {
		return fmt.Errorf("open release ZIP: %w", err)
	}
	defer reader.Close()
	if len(reader.File) == 0 || len(reader.File) > maxArchiveEntries {
		return fmt.Errorf("release ZIP contains an invalid number of entries: %d", len(reader.File))
	}

	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		return err
	}

	var total int64
	for _, archived := range reader.File {
		cleanName, err := safeArchiveName(archived.Name)
		if err != nil {
			return err
		}
		mode := archived.Mode()
		if mode&os.ModeSymlink != 0 || (!mode.IsDir() && !mode.IsRegular()) {
			return fmt.Errorf("unsupported ZIP entry type: %q", archived.Name)
		}
		if archived.UncompressedSize64 > uint64(maxUncompressedZIP-total) {
			return fmt.Errorf("release ZIP exceeds the %d byte extraction limit", maxUncompressedZIP)
		}
		total += int64(archived.UncompressedSize64)

		target := filepath.Join(destination, filepath.FromSlash(cleanName))
		if err := ensureWithin(destination, target); err != nil {
			return err
		}
		if mode.IsDir() || strings.HasSuffix(archived.Name, "/") {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := extractFile(archived, target); err != nil {
			return err
		}
	}

	if err := validateAppDirectory(filepath.Join(destination, appDirectory)); err != nil {
		return fmt.Errorf("invalid release ZIP: %w", err)
	}
	return nil
}

func safeArchiveName(name string) (string, error) {
	if strings.Contains(name, "\\") {
		return "", fmt.Errorf("ZIP entry contains a backslash: %q", name)
	}
	clean := path.Clean(name)
	if clean == "." || path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("unsafe ZIP entry path: %q", name)
	}
	if clean != appDirectory && !strings.HasPrefix(clean, appDirectory+"/") {
		return "", fmt.Errorf("ZIP entry must be under %s/: %q", appDirectory, name)
	}
	return clean, nil
}

func ensureWithin(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return err
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("ZIP entry escapes extraction directory: %s", target)
	}
	return nil
}

func extractFile(archived *zip.File, target string) (returnErr error) {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	input, err := archived.Open()
	if err != nil {
		return err
	}
	defer input.Close()

	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		closeErr := output.Close()
		if returnErr == nil {
			returnErr = closeErr
		}
	}()
	_, err = io.Copy(output, input)
	return err
}

func validateAppDirectory(directory string) error {
	info, err := os.Stat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("app path is not a directory")
	}

	manifestPath := filepath.Join(directory, "manifest.json")
	contents, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest.json: %w", err)
	}
	var parsed manifest
	if err := json.Unmarshal(contents, &parsed); err != nil {
		return fmt.Errorf("parse manifest.json: %w", err)
	}
	if parsed.Description != requiredBackendDescription || !parsed.RequiresBackend ||
		parsed.BackendInstallation != backendInstallationURL {
		return errors.New("manifest description must disclose the required backend service and link INSTALL.md")
	}
	entrypoint := path.Clean(parsed.Entrypoint)
	if parsed.Entrypoint == "" || path.IsAbs(entrypoint) || entrypoint == ".." || strings.HasPrefix(entrypoint, "../") {
		return fmt.Errorf("manifest has unsafe entrypoint %q", parsed.Entrypoint)
	}
	entrypointPath := filepath.Join(directory, filepath.FromSlash(entrypoint))
	if err := ensureWithin(directory, entrypointPath); err != nil {
		return err
	}
	entryInfo, err := os.Stat(entrypointPath)
	if err != nil {
		return fmt.Errorf("manifest entrypoint does not exist: %w", err)
	}
	if !entryInfo.Mode().IsRegular() {
		return errors.New("manifest entrypoint is not a regular file")
	}
	jsInfo, err := os.Stat(filepath.Join(directory, "js"))
	if err != nil || !jsInfo.IsDir() {
		return errors.New("release app is missing the js directory")
	}
	return nil
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "package-web: "+format+"\n", args...)
	os.Exit(1)
}
