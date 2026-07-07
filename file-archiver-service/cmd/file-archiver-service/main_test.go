package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	yzip "github.com/yeka/zip"
)

func TestSafeArchivePath(t *testing.T) {
	tests := []struct {
		name    string
		want    string
		wantErr bool
	}{
		{name: "file.txt", want: "file.txt"},
		{name: "dir/file.txt", want: "dir/file.txt"},
		{name: "./dir/../dir/file.txt", want: "dir/file.txt"},
		{name: "../escape.txt", wantErr: true},
		{name: "/absolute.txt", wantErr: true},
		{name: "C:/windows.txt", wantErr: true},
		{name: `back\slash.txt`, wantErr: true},
		{name: "//server/share.txt", wantErr: true},
		{name: "bad\x00name", wantErr: true},
	}
	for _, tt := range tests {
		got, err := safeArchivePath(tt.name)
		if tt.wantErr {
			if err == nil {
				t.Fatalf("safeArchivePath(%q) expected error, got nil", tt.name)
			}
			continue
		}
		if err != nil {
			t.Fatalf("safeArchivePath(%q) unexpected error: %v", tt.name, err)
		}
		if got != tt.want {
			t.Fatalf("safeArchivePath(%q) = %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestDetectArchiveKindWhitelist(t *testing.T) {
	tests := map[string]string{
		"archive.zip":    "zip",
		"archive.7z":     "7z",
		"archive.tar":    "tar",
		"archive.tar.gz": "tar.gz",
		"archive.tgz":    "tar.gz",
		"archive.gz":     "gz",
		"archive.rar":    "",
	}
	for name, want := range tests {
		if got := detectArchiveKind(name, ""); got != want {
			t.Fatalf("detectArchiveKind(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestValidateExtractionRejectsRAR(t *testing.T) {
	req := &extractionRequest{
		Source:      sourceRef{SpaceID: "space", Path: "/archive.rar", Name: "archive.rar"},
		Destination: destinationRef{SpaceID: "space", FolderPath: "/out"},
	}
	if err := validateExtractionRequest(req); err == nil {
		t.Fatal("validateExtractionRequest accepted rar")
	}
}

func TestZipHasWinZipAES(t *testing.T) {
	var buf bytes.Buffer
	zw := yzip.NewWriter(&buf)
	w, err := zw.Encrypt("secret.txt", "password", yzip.AES256Encryption)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("secret")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := yzip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 1 {
		t.Fatalf("file count = %d, want 1", len(zr.File))
	}
	if !zr.File[0].IsEncrypted() {
		t.Fatal("zip entry is not encrypted")
	}
	if !zipHasWinZipAES(zr.File[0].Extra) {
		t.Fatal("zipHasWinZipAES returned false for AES encrypted entry")
	}
}

func TestZipCreatedTimeNTFSExtra(t *testing.T) {
	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	mtime := time.Date(2026, 1, 3, 3, 4, 5, 0, time.UTC)
	atime := time.Date(2026, 1, 4, 3, 4, 5, 0, time.UTC)

	var tag bytes.Buffer
	_ = binary.Write(&tag, binary.LittleEndian, uint16(0x0001))
	_ = binary.Write(&tag, binary.LittleEndian, uint16(24))
	_ = binary.Write(&tag, binary.LittleEndian, windowsFileTimeValue(mtime))
	_ = binary.Write(&tag, binary.LittleEndian, windowsFileTimeValue(atime))
	_ = binary.Write(&tag, binary.LittleEndian, windowsFileTimeValue(created))

	block := append([]byte{0, 0, 0, 0}, tag.Bytes()...)
	extra := make([]byte, 4+len(block))
	binary.LittleEndian.PutUint16(extra[0:2], 0x000a)
	binary.LittleEndian.PutUint16(extra[2:4], uint16(len(block)))
	copy(extra[4:], block)

	if got := zipCreatedTime(extra); !got.Equal(created) {
		t.Fatalf("zipCreatedTime() = %s, want %s", got, created)
	}
}

func TestDAVClientURLEncodesPathSegmentsOnce(t *testing.T) {
	base, err := url.Parse("https://cloud.example/base/")
	if err != nil {
		t.Fatal(err)
	}
	dc := &davClient{base: base}

	got := dc.url("space$id", "/seven-out (1).zip")
	want := "https://cloud.example/base/dav/spaces/space$id/seven-out%20%281%29.zip"
	if got != want {
		t.Fatalf("url() = %q, want %q", got, want)
	}
	if strings.Contains(got, "%2520") || strings.Contains(got, "%2528") {
		t.Fatalf("url() double-encoded path segments: %q", got)
	}

	got = dc.url("space$id", "/literal%name.zip")
	want = "https://cloud.example/base/dav/spaces/space$id/literal%25name.zip"
	if got != want {
		t.Fatalf("url() = %q, want %q", got, want)
	}
}

func TestDAVClientHeaderTimeout(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusMultiStatus)
	}))
	defer slow.Close()

	svc, err := newServer(config{
		opencloudURL:      slow.URL,
		tmpDir:            t.TempDir(),
		davHeaderTimeout:  50 * time.Millisecond,
		davRequestTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	dc, err := svc.newDAVClient("Bearer test-token")
	if err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	_, err = dc.stat(context.Background(), "space-id", "/file.txt")
	if err == nil {
		t.Fatal("stat unexpectedly succeeded")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("stat took %s, want timeout within 1s", elapsed)
	}
}

func windowsFileTimeValue(t time.Time) uint64 {
	const windowsToUnixSeconds = 11644473600
	const ticksPerSecond = 10000000
	utc := t.UTC()
	return uint64(utc.Unix()+windowsToUnixSeconds)*ticksPerSecond + uint64(utc.Nanosecond()/100)
}

func TestCompressionSaveJobWithFakeWebDAV(t *testing.T) {
	fake := newFakeDAV()
	fake.requirePutContentLength = true
	fake.putFile("/source.txt", []byte("hello archive"))
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"format":"zip",
		"sources":[{"spaceId":"space-id","path":"/source.txt","name":"source.txt","size":13}],
		"output":{"mode":"save","destination":{"spaceId":"space-id","folderPath":"/archives","fileName":"source.zip"}},
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/compressions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("create compression status = %d", res.StatusCode)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	defer res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusSucceeded {
		t.Fatalf("job status = %s, error=%s code=%s", done.Status, done.Error, done.Code)
	}

	raw := fake.file("/archives/source.zip")
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 1 || zr.File[0].Name != "source.txt" {
		t.Fatalf("zip files = %#v", zr.File)
	}
	rc, err := zr.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello archive" {
		t.Fatalf("zip content = %q", got)
	}
}

func TestZipExtractionJobWithFakeWebDAV(t *testing.T) {
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	w, err := zw.Create("dir/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("extracted")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.requirePutContentLength = true
	fake.putFile("/archive.zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/archive.zip","name":"archive.zip","mimeType":"application/zip"},
		"destination":{"spaceId":"space-id","folderPath":"/out"},
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/extractions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("create extraction status = %d", res.StatusCode)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	defer res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusSucceeded {
		t.Fatalf("job status = %s, error=%s code=%s", done.Status, done.Error, done.Code)
	}
	if got := string(fake.file("/out/dir/file.txt")); got != "extracted" {
		t.Fatalf("extracted content = %q", got)
	}
}

func TestZipExtractionDefaultsToKeepBothOnFileConflict(t *testing.T) {
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	w, err := zw.Create("dir/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("archive content")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.requirePutContentLength = true
	fake.putFile("/archive.zip", archive.Bytes())
	fake.putFile("/out/dir/file.txt", []byte("existing content"))
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/archive.zip","name":"archive.zip","mimeType":"application/zip"},
		"destination":{"spaceId":"space-id","folderPath":"/out"}
	}`
	res := doJSON(t, api.URL+"/api/extractions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create extraction status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusSucceeded {
		t.Fatalf("job status = %s, error=%s code=%s", done.Status, done.Error, done.Code)
	}
	if got := string(fake.file("/out/dir/file.txt")); got != "existing content" {
		t.Fatalf("existing content = %q, want unchanged", got)
	}
	if got := string(fake.file("/out/dir/file (1).txt")); got != "archive content" {
		t.Fatalf("renamed content = %q", got)
	}
}

func TestDeleteTerminalJobRemovesItFromList(t *testing.T) {
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	w, err := zw.Create("file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("content")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.requirePutContentLength = true
	fake.putFile("/archive.zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/archive.zip","name":"archive.zip","mimeType":"application/zip"},
		"destination":{"spaceId":"space-id","folderPath":"/out"}
	}`
	res := doJSON(t, api.URL+"/api/extractions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create extraction status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusSucceeded {
		t.Fatalf("job status = %s, error=%s code=%s", done.Status, done.Error, done.Code)
	}

	listed := listJobs(t, api.URL)
	if len(listed) != 1 || listed[0].ID != created.ID {
		t.Fatalf("listed jobs = %#v, want created job", listed)
	}

	req, err := http.NewRequest(http.MethodDelete, api.URL+"/api/jobs/"+created.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("delete job status = %d, body=%s", res.StatusCode, data)
	}
	_ = res.Body.Close()

	listed = listJobs(t, api.URL)
	if len(listed) != 0 {
		t.Fatalf("listed jobs after delete = %#v, want none", listed)
	}

	req, err = http.NewRequest(http.MethodGet, api.URL+"/api/jobs/"+created.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("get deleted job status = %d, body=%s", res.StatusCode, data)
	}
}

func TestZipPreviewListsAndStreamsEntryWithFakeWebDAV(t *testing.T) {
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	w, err := zw.Create("dir/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("preview me")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.putFile("/archive.zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/archive.zip","name":"archive.zip","mimeType":"application/zip"}
	}`
	res := doJSON(t, api.URL+"/api/previews", http.MethodPost, body)
	if res.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create preview status = %d, body=%s", res.StatusCode, data)
	}
	var preview publicPreview
	decodeJSON(t, res.Body, &preview)
	_ = res.Body.Close()
	if preview.ID == "" {
		t.Fatal("preview id is empty")
	}

	var fileEntry previewEntry
	for _, entry := range preview.Entries {
		if entry.Path == "dir/file.txt" {
			fileEntry = entry
			break
		}
	}
	if fileEntry.ID == "" {
		t.Fatalf("file entry not found in preview entries: %#v", preview.Entries)
	}
	if fileEntry.PreviewKind != "text" {
		t.Fatalf("preview kind = %q, want text", fileEntry.PreviewKind)
	}

	req, err := http.NewRequest(http.MethodGet, api.URL+"/api/previews/"+preview.ID+"/entries?path=dir", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("list entries status = %d, body=%s", res.StatusCode, data)
	}
	var listed struct {
		Entries []previewEntry `json:"entries"`
	}
	decodeJSON(t, res.Body, &listed)
	_ = res.Body.Close()
	if len(listed.Entries) != 1 || listed.Entries[0].Path != "dir/file.txt" {
		t.Fatalf("listed entries = %#v", listed.Entries)
	}

	req, err = http.NewRequest(http.MethodGet, api.URL+"/api/previews/"+preview.ID+"/entries/"+fileEntry.ID+"/content", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("content status = %d, body=%s", res.StatusCode, data)
	}
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "preview me" {
		t.Fatalf("preview content = %q", data)
	}

	req, err = http.NewRequest(http.MethodPost, api.URL+"/api/previews/"+preview.ID+"/entries/"+fileEntry.ID+"/download", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create download status = %d, body=%s", res.StatusCode, data)
	}
	var download struct {
		DownloadURL string `json:"downloadUrl"`
	}
	decodeJSON(t, res.Body, &download)
	_ = res.Body.Close()
	if download.DownloadURL == "" {
		t.Fatal("download url is empty")
	}

	entryDownloadURL := api.URL + strings.TrimPrefix(download.DownloadURL, "/archive")
	req, err = http.NewRequest(http.MethodGet, entryDownloadURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("download status = %d, body=%s", res.StatusCode, data)
	}
	if got := res.Header.Get("Content-Disposition"); !strings.HasPrefix(got, "attachment") {
		t.Fatalf("content disposition = %q, want attachment", got)
	}
	data, err = io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "preview me" {
		t.Fatalf("download content = %q", data)
	}

	req, err = http.NewRequest(http.MethodGet, entryDownloadURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("second download status = %d, body=%s", res.StatusCode, data)
	}
}

func TestCreatePreviewUsesWorkerSemaphore(t *testing.T) {
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	w, err := zw.Create("file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("preview waits")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.putFile("/archive.zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	for i := 0; i < cap(svc.sem); i++ {
		svc.sem <- struct{}{}
	}
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/archive.zip","name":"archive.zip","mimeType":"application/zip"}
	}`
	done := make(chan *http.Response, 1)
	go func() {
		done <- doJSON(t, api.URL+"/api/previews", http.MethodPost, body)
	}()

	select {
	case res := <-done:
		data, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		t.Fatalf("preview completed while workers were occupied: status=%d body=%s", res.StatusCode, data)
	case <-time.After(100 * time.Millisecond):
	}

	for i := 0; i < cap(svc.sem); i++ {
		<-svc.sem
	}
	res := <-done
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create preview status = %d, body=%s", res.StatusCode, data)
	}
}

func TestPreviewContentUsesWorkerSemaphore(t *testing.T) {
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	w, err := zw.Create("file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("content waits")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.putFile("/archive.zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/archive.zip","name":"archive.zip","mimeType":"application/zip"}
	}`
	res := doJSON(t, api.URL+"/api/previews", http.MethodPost, body)
	if res.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create preview status = %d, body=%s", res.StatusCode, data)
	}
	var preview publicPreview
	decodeJSON(t, res.Body, &preview)
	_ = res.Body.Close()
	if len(preview.Entries) == 0 {
		t.Fatal("preview entries are empty")
	}
	fileEntry := previewEntry{}
	for _, entry := range preview.Entries {
		if !entry.IsDir {
			fileEntry = entry
			break
		}
	}
	if fileEntry.ID == "" {
		t.Fatalf("file entry not found in preview entries: %#v", preview.Entries)
	}

	for i := 0; i < cap(svc.sem); i++ {
		svc.sem <- struct{}{}
	}
	done := make(chan *http.Response, 1)
	go func() {
		req, err := http.NewRequest(http.MethodGet, api.URL+"/api/previews/"+preview.ID+"/entries/"+fileEntry.ID+"/content", nil)
		if err != nil {
			t.Error(err)
			return
		}
		req.Header.Set("Authorization", "Bearer test-token")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Error(err)
			return
		}
		done <- res
	}()

	select {
	case res := <-done:
		data, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		t.Fatalf("preview content completed while workers were occupied: status=%d body=%s", res.StatusCode, data)
	case <-time.After(100 * time.Millisecond):
	}

	for i := 0; i < cap(svc.sem); i++ {
		<-svc.sem
	}
	res = <-done
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("content status = %d, body=%s", res.StatusCode, data)
	}
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "content waits" {
		t.Fatalf("preview content = %q", data)
	}
}

func TestZipPreviewEncryptedArchiveRequiresPassword(t *testing.T) {
	var archive bytes.Buffer
	zw := yzip.NewWriter(&archive)
	w, err := zw.Encrypt("secret.txt", "password", yzip.AES256Encryption)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("secret")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.putFile("/secret.zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/secret.zip","name":"secret.zip","mimeType":"application/zip"}
	}`
	res := doJSON(t, api.URL+"/api/previews", http.MethodPost, body)
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("preview status = %d, body=%s", res.StatusCode, data)
	}
	var payload map[string]string
	decodeJSON(t, res.Body, &payload)
	if payload["code"] != "PASSWORD_REQUIRED" {
		t.Fatalf("code = %q, want PASSWORD_REQUIRED", payload["code"])
	}
}

func TestZipPreviewAndExtractionWithEscapedSourcePath(t *testing.T) {
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	w, err := zw.Create("dir/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("escaped source")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.requirePutContentLength = true
	fake.putFile("/seven-out (1).zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	previewBody := `{
		"source":{"spaceId":"space-id","path":"/seven-out (1).zip","name":"seven-out (1).zip","mimeType":"application/zip"}
	}`
	res := doJSON(t, api.URL+"/api/previews", http.MethodPost, previewBody)
	if res.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create preview status = %d, body=%s", res.StatusCode, data)
	}
	var preview publicPreview
	decodeJSON(t, res.Body, &preview)
	_ = res.Body.Close()
	if len(preview.Entries) == 0 {
		t.Fatal("preview entries are empty")
	}

	extractBody := `{
		"source":{"spaceId":"space-id","path":"/seven-out (1).zip","name":"seven-out (1).zip","mimeType":"application/zip"},
		"destination":{"spaceId":"space-id","folderPath":"/out"},
		"conflicts":"fail"
	}`
	res = doJSON(t, api.URL+"/api/extractions", http.MethodPost, extractBody)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create extraction status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusSucceeded {
		t.Fatalf("job status = %s, error=%s code=%s", done.Status, done.Error, done.Code)
	}
	if got := string(fake.file("/out/dir/file.txt")); got != "escaped source" {
		t.Fatalf("extracted content = %q", got)
	}
}

func TestZipExtractionEncryptedArchiveRequiresPassword(t *testing.T) {
	var archive bytes.Buffer
	zw := yzip.NewWriter(&archive)
	if _, err := zw.Create("seven-out/"); err != nil {
		t.Fatal(err)
	}
	w, err := zw.Encrypt("seven-out/seven.txt", "password", yzip.AES256Encryption)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("encrypted content")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.requirePutContentLength = true
	fake.putFile("/secret.zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	dc, err := svc.newDAVClient("Bearer test-token")
	if err != nil {
		t.Fatal(err)
	}
	rangeReader := dc.readerAt(context.Background(), "space-id", "/secret.zip", int64(archive.Len()), 4096, nil)
	rangeZip, err := yzip.NewReader(rangeReader, int64(archive.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(rangeZip.File) != 2 {
		t.Fatalf("range file count = %d, want 2", len(rangeZip.File))
	}
	if rangeZip.File[1].FileInfo().IsDir() {
		t.Fatalf("range file %q is incorrectly marked as a directory", rangeZip.File[1].Name)
	}
	if !rangeZip.File[1].IsEncrypted() {
		t.Fatalf("range file %q is not marked encrypted, flags=%d method=%d extra=%x", rangeZip.File[1].Name, rangeZip.File[1].Flags, rangeZip.File[1].Method, rangeZip.File[1].Extra)
	}

	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/secret.zip","name":"secret.zip","mimeType":"application/zip"},
		"destination":{"spaceId":"space-id","folderPath":"/out"},
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/extractions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create extraction status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusFailed {
		t.Fatalf("job status = %s, want failed", done.Status)
	}
	if done.Code != "PASSWORD_REQUIRED" {
		t.Fatalf("job code = %q, want PASSWORD_REQUIRED; error=%s", done.Code, done.Error)
	}
	if got := fake.file("/out/seven-out/seven.txt"); got != nil {
		t.Fatalf("encrypted file was extracted without password: %q", got)
	}
}

func TestZipExtractionJobCanIncludeSelectedPaths(t *testing.T) {
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	for name, content := range map[string]string{
		"dir/keep.txt": "keep",
		"dir/skip.txt": "skip",
	} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.requirePutContentLength = true
	fake.putFile("/archive.zip", archive.Bytes())
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"source":{"spaceId":"space-id","path":"/archive.zip","name":"archive.zip","mimeType":"application/zip"},
		"destination":{"spaceId":"space-id","folderPath":"/out"},
		"includePaths":["dir/keep.txt"],
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/extractions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create extraction status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusSucceeded {
		t.Fatalf("job status = %s, error=%s code=%s", done.Status, done.Error, done.Code)
	}
	if got := string(fake.file("/out/dir/keep.txt")); got != "keep" {
		t.Fatalf("included content = %q", got)
	}
	if got := fake.file("/out/dir/skip.txt"); got != nil {
		t.Fatalf("excluded file was extracted: %q", got)
	}
}

func TestCompressionDownloadJobUsesDownloadToken(t *testing.T) {
	fake := newFakeDAV()
	fake.putFile("/source.txt", []byte("download archive"))
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"format":"zip",
		"sources":[{"spaceId":"space-id","path":"/source.txt","name":"source.txt","size":16}],
		"output":{"mode":"download","fileName":"source.zip"},
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/compressions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("create compression status = %d", res.StatusCode)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	defer res.Body.Close()
	if !strings.Contains(created.Output.DownloadURL, "token=") {
		t.Fatalf("download URL does not contain token: %q", created.Output.DownloadURL)
	}

	downloadURL := api.URL + created.Output.DownloadURL
	res, err := http.Get(downloadURL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("download status = %d, body=%s", res.StatusCode, data)
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	rc, err := zr.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "download archive" {
		t.Fatalf("downloaded zip content = %q", got)
	}
}

func TestCompressionDownloadJobEnforcesOutputLimit(t *testing.T) {
	source := make([]byte, 4096)
	if _, err := rand.Read(source); err != nil {
		t.Fatal(err)
	}

	fake := newFakeDAV()
	fake.putFile("/source.bin", source)
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	svc.cfg.maxOutputBytes = 256
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"format":"zip",
		"sources":[{"spaceId":"space-id","path":"/source.bin","name":"source.bin","size":4096}],
		"output":{"mode":"download","fileName":"source.zip"},
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/compressions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create compression status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()
	if !strings.Contains(created.Output.DownloadURL, "token=") {
		t.Fatalf("download URL does not contain token: %q", created.Output.DownloadURL)
	}

	res, err := http.Get(api.URL + created.Output.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusFailed {
		t.Fatalf("job status = %s, want failed", done.Status)
	}
	if done.Code != "OUTPUT_TOO_LARGE" {
		t.Fatalf("job code = %q, want OUTPUT_TOO_LARGE; error=%s", done.Code, done.Error)
	}
}

func TestCompressionDownloadTokenExpires(t *testing.T) {
	fake := newFakeDAV()
	fake.putFile("/source.txt", []byte("expired token"))
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	svc.cfg.downloadTokenTTL = 50 * time.Millisecond
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"format":"zip",
		"sources":[{"spaceId":"space-id","path":"/source.txt","name":"source.txt","size":13}],
		"output":{"mode":"download","fileName":"source.zip"},
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/compressions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create compression status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()
	if !strings.Contains(created.Output.DownloadURL, "token=") {
		t.Fatalf("download URL does not contain token: %q", created.Output.DownloadURL)
	}

	time.Sleep(75 * time.Millisecond)
	res, err := http.Get(api.URL + created.Output.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("download status = %d, body=%s", res.StatusCode, data)
	}
}

func TestTerminalJobClearsSecrets(t *testing.T) {
	fake := newFakeDAV()
	fake.requirePutContentLength = true
	fake.putFile("/source.txt", []byte("secret cleanup"))
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"format":"zip",
		"sources":[{"spaceId":"space-id","path":"/source.txt","name":"source.txt","size":14}],
		"encryption":{"method":"zip-aes256","password":"archive-password"},
		"output":{"mode":"save","destination":{"spaceId":"space-id","folderPath":"/archives","fileName":"source.zip"}},
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/compressions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create compression status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusSucceeded {
		t.Fatalf("job status = %s, error=%s code=%s", done.Status, done.Error, done.Code)
	}

	svc.mu.RLock()
	stored := svc.jobs[created.ID]
	svc.mu.RUnlock()
	if stored == nil {
		t.Fatal("stored job not found")
	}
	stored.mu.Lock()
	auth := stored.Authorization
	token := stored.DownloadToken
	password := stored.Compression.Encryption.Password
	stored.mu.Unlock()
	if auth != "" {
		t.Fatalf("authorization was not cleared: %q", auth)
	}
	if token != "" {
		t.Fatalf("download token was not cleared: %q", token)
	}
	if password != "" {
		t.Fatalf("encryption password was not cleared: %q", password)
	}
}

func TestCompressionPlanStopsWalkingAfterEntryLimit(t *testing.T) {
	fake := newFakeDAV()
	fake.putFile("/folder/a.txt", []byte("a"))
	fake.putFile("/folder/b.txt", []byte("b"))
	fake.putFile("/folder/c.txt", []byte("c"))
	davServer := httptest.NewServer(fake)
	defer davServer.Close()

	svc := newTestArchiveServer(t, davServer.URL)
	svc.cfg.maxEntries = 1
	api := httptest.NewServer(svc)
	defer api.Close()

	body := `{
		"format":"zip",
		"sources":[{"spaceId":"space-id","path":"/folder","name":"folder"}],
		"output":{"mode":"save","destination":{"spaceId":"space-id","folderPath":"/archives","fileName":"folder.zip"}},
		"conflicts":"fail"
	}`
	res := doJSON(t, api.URL+"/api/compressions", http.MethodPost, body)
	if res.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("create compression status = %d, body=%s", res.StatusCode, data)
	}
	var created publicJob
	decodeJSON(t, res.Body, &created)
	_ = res.Body.Close()

	done := waitJob(t, api.URL, created.ID)
	if done.Status != statusFailed {
		t.Fatalf("job status = %s, want failed", done.Status)
	}
	if done.Code != "TOO_MANY_ENTRIES" {
		t.Fatalf("job code = %q, want TOO_MANY_ENTRIES; error=%s", done.Code, done.Error)
	}
	if got := fake.propfindCallCount("/folder/", "0"); got != 1 {
		t.Fatalf("child stat PROPFIND count = %d, want 1", got)
	}
}

func newTestArchiveServer(t *testing.T, opencloudURL string) *server {
	t.Helper()
	svc, err := newServer(config{
		opencloudURL:      opencloudURL,
		tmpDir:            t.TempDir(),
		jsonLimit:         1 << 20,
		maxArchiveBytes:   100 << 20,
		maxOutputBytes:    100 << 20,
		maxEntryBytes:     100 << 20,
		maxEntries:        1000,
		maxConcurrentJobs: 2,
		jobTTL:            time.Hour,
		aesBufferLimit:    10 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func doJSON(t *testing.T, endpoint, method, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, endpoint, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func waitJob(t *testing.T, baseURL, id string) publicJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		req, err := http.NewRequest(http.MethodGet, baseURL+"/api/jobs/"+id, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer test-token")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var job publicJob
		decodeJSON(t, res.Body, &job)
		_ = res.Body.Close()
		if job.Status == statusSucceeded || job.Status == statusFailed || job.Status == statusCancelled {
			return job
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for job")
	return publicJob{}
}

func listJobs(t *testing.T, baseURL string) []publicJob {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+"/api/jobs", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("list jobs status = %d, body=%s", res.StatusCode, data)
	}
	var payload struct {
		Jobs []publicJob `json:"jobs"`
	}
	decodeJSON(t, res.Body, &payload)
	return payload.Jobs
}

func decodeJSON(t *testing.T, r io.Reader, out any) {
	t.Helper()
	if err := json.NewDecoder(r).Decode(out); err != nil {
		t.Fatal(err)
	}
}

type fakeDAV struct {
	mu                      sync.Mutex
	files                   map[string][]byte
	dirs                    map[string]bool
	spaceID                 string
	requirePutContentLength bool
	propfindCalls           []propfindCall
}

type propfindCall struct {
	path  string
	depth string
}

func newFakeDAV() *fakeDAV {
	return &fakeDAV{
		files:   map[string][]byte{},
		dirs:    map[string]bool{"/": true},
		spaceID: "space-id",
	}
}

func (f *fakeDAV) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := fakeDAVPath(r.URL.EscapedPath(), f.spaceID)
	switch r.Method {
	case http.MethodGet:
		f.handleGet(w, r, p)
	case http.MethodPut:
		f.handlePut(w, r, p)
	case "MKCOL":
		f.handleMKCOL(w, p)
	case "MOVE":
		f.handleMove(w, r, p)
	case http.MethodDelete:
		f.handleDelete(w, p)
	case "PROPFIND":
		f.handlePropfind(w, r, p)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (f *fakeDAV) putFile(p string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p = cleanDavPath(p)
	f.ensureDirLocked(path.Dir(p))
	f.files[p] = append([]byte(nil), data...)
}

func (f *fakeDAV) file(p string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.files[cleanDavPath(p)]...)
}

func (f *fakeDAV) propfindCallCount(prefix, depth string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, call := range f.propfindCalls {
		if call.depth == depth && strings.HasPrefix(call.path, prefix) {
			count++
		}
	}
	return count
}

func (f *fakeDAV) handleGet(w http.ResponseWriter, r *http.Request, p string) {
	f.mu.Lock()
	data, ok := f.files[p]
	f.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
		start, end, ok := parseByteRange(rangeHeader, int64(len(data)))
		if !ok {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(data)))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data[start : end+1])
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

func parseByteRange(value string, size int64) (int64, int64, bool) {
	if !strings.HasPrefix(value, "bytes=") || size < 0 {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(value, "bytes=")
	parts := strings.SplitN(spec, "-", 2)
	if len(parts) != 2 || parts[0] == "" {
		return 0, 0, false
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	end := size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, 0, false
		}
	}
	if end < start {
		return 0, 0, false
	}
	if end >= size {
		end = size - 1
	}
	return start, end, true
}

func (f *fakeDAV) handlePut(w http.ResponseWriter, r *http.Request, p string) {
	if f.requirePutContentLength && r.ContentLength < 0 {
		w.WriteHeader(http.StatusLengthRequired)
		return
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	f.putFile(p, data)
	w.WriteHeader(http.StatusCreated)
}

func (f *fakeDAV) handleMKCOL(w http.ResponseWriter, p string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dirs[p] {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	f.ensureDirLocked(p)
	w.WriteHeader(http.StatusCreated)
}

func (f *fakeDAV) handleMove(w http.ResponseWriter, r *http.Request, src string) {
	dstURL, err := url.Parse(r.Header.Get("Destination"))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	dst := fakeDAVPath(dstURL.EscapedPath(), f.spaceID)
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.files[src]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	f.ensureDirLocked(path.Dir(dst))
	f.files[dst] = data
	delete(f.files, src)
	w.WriteHeader(http.StatusCreated)
}

func (f *fakeDAV) handleDelete(w http.ResponseWriter, p string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.files, p)
	delete(f.dirs, p)
	w.WriteHeader(http.StatusNoContent)
}

func (f *fakeDAV) handlePropfind(w http.ResponseWriter, r *http.Request, p string) {
	depth := r.Header.Get("Depth")
	f.mu.Lock()
	defer f.mu.Unlock()
	f.propfindCalls = append(f.propfindCalls, propfindCall{path: p, depth: depth})
	var paths []string
	if f.existsLocked(p) {
		paths = append(paths, p)
	}
	if depth == "1" && f.dirs[p] {
		prefix := strings.TrimRight(p, "/") + "/"
		for file := range f.files {
			if path.Dir(file) == strings.TrimRight(p, "/") {
				paths = append(paths, file)
			}
		}
		for dir := range f.dirs {
			if dir != p && strings.HasPrefix(dir, prefix) && path.Dir(dir) == strings.TrimRight(p, "/") {
				paths = append(paths, dir)
			}
		}
	}
	if len(paths) == 0 {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/xml")
	_, _ = fmt.Fprint(w, `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">`)
	for _, item := range paths {
		f.writeProp(w, item)
	}
	_, _ = fmt.Fprint(w, `</d:multistatus>`)
}

func (f *fakeDAV) writeProp(w http.ResponseWriter, p string) {
	name := path.Base(strings.TrimSuffix(p, "/"))
	if p == "/" {
		name = ""
	}
	href := "/dav/spaces/" + url.PathEscape(f.spaceID)
	if p != "/" {
		href += "/" + encodePathSegments(p)
	}
	size := 0
	resourceType := ""
	if f.dirs[p] {
		resourceType = "<d:collection/>"
	} else {
		size = len(f.files[p])
	}
	_, _ = fmt.Fprintf(
		w,
		`<d:response><d:href>%s</d:href><d:propstat><d:prop><d:displayname>%s</d:displayname><d:resourcetype>%s</d:resourcetype><d:getcontentlength>%d</d:getcontentlength><d:getlastmodified>%s</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
		xmlEscape(href),
		xmlEscape(name),
		resourceType,
		size,
		time.Now().UTC().Format(http.TimeFormat),
	)
}

func (f *fakeDAV) existsLocked(p string) bool {
	return f.dirs[p] || f.files[p] != nil
}

func (f *fakeDAV) ensureDirLocked(p string) {
	p = cleanDavPath(p)
	if p == "/" {
		f.dirs[p] = true
		return
	}
	parts := strings.Split(strings.Trim(p, "/"), "/")
	current := ""
	for _, part := range parts {
		current += "/" + part
		f.dirs[current] = true
	}
}

func fakeDAVPath(requestPath, spaceID string) string {
	prefix := "/dav/spaces/" + url.PathEscape(spaceID)
	parts := strings.SplitN(strings.TrimPrefix(requestPath, prefix), "?", 2)
	value, _ := url.PathUnescape(parts[0])
	return cleanDavPath(value)
}

func xmlEscape(value string) string {
	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(value))
	return buf.String()
}
