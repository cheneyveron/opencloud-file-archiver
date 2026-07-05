package main

import (
	"archive/zip"
	"bytes"
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
	requirePutContentLength bool
}

func newFakeDAV() *fakeDAV {
	return &fakeDAV{
		files: map[string][]byte{},
		dirs:  map[string]bool{"/": true},
	}
}

func (f *fakeDAV) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := fakeDAVPath(r.URL.Path)
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
	dst := fakeDAVPath(dstURL.Path)
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
	href := "/dav/spaces/space-id" + p
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

func fakeDAVPath(requestPath string) string {
	parts := strings.SplitN(strings.TrimPrefix(requestPath, "/dav/spaces/space-id"), "?", 2)
	value, _ := url.PathUnescape(parts[0])
	return cleanDavPath(value)
}

func xmlEscape(value string) string {
	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(value))
	return buf.String()
}
