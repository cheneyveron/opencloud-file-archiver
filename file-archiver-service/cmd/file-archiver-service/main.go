package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/bodgit/sevenzip"
	"github.com/nwaples/rardecode/v2"
	yzip "github.com/yeka/zip"
)

const (
	statusQueued    = "queued"
	statusRunning   = "running"
	statusSucceeded = "succeeded"
	statusFailed    = "failed"
	statusCancelled = "cancelled"

	jobExtraction  = "extraction"
	jobCompression = "compression"

	outputSave     = "save"
	outputDownload = "download"
)

type config struct {
	port              string
	opencloudURL      string
	tmpDir            string
	jsonLimit         int64
	maxArchiveBytes   int64
	maxOutputBytes    int64
	maxEntryBytes     int64
	maxPreviewBytes   int64
	maxEntries        int
	maxConcurrentJobs int
	jobTTL            time.Duration
	davRequestTimeout time.Duration
	davHeaderTimeout  time.Duration
	downloadTokenTTL  time.Duration
	aesBufferLimit    uint64
	rarDictionarySize int64
	rangeBlockSize    int64
}

type appError struct {
	Status  int
	Code    string
	Message string
}

func (e *appError) Error() string { return e.Message }

func newError(status int, code, message string) *appError {
	return &appError{Status: status, Code: code, Message: message}
}

type sourceRef struct {
	SpaceID  string `json:"spaceId"`
	Path     string `json:"path"`
	Name     string `json:"name,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	Size     int64  `json:"size,omitempty"`
}

type destinationRef struct {
	SpaceID    string `json:"spaceId"`
	Path       string `json:"path,omitempty"`
	FolderPath string `json:"folderPath,omitempty"`
	FileName   string `json:"fileName,omitempty"`
}

type extractionRequest struct {
	Source       sourceRef      `json:"source"`
	Destination  destinationRef `json:"destination"`
	Password     string         `json:"password,omitempty"`
	IncludePaths []string       `json:"includePaths,omitempty"`
	Conflicts    string         `json:"conflicts,omitempty"`
}

type encryptionSpec struct {
	Method   string `json:"method,omitempty"`
	Password string `json:"password,omitempty"`
}

type compressionOutput struct {
	Mode        string         `json:"mode"`
	FileName    string         `json:"fileName,omitempty"`
	Destination destinationRef `json:"destination,omitempty"`
}

type compressionRequest struct {
	Format     string            `json:"format"`
	Sources    []sourceRef       `json:"sources"`
	Encryption *encryptionSpec   `json:"encryption,omitempty"`
	Output     compressionOutput `json:"output"`
	Conflicts  string            `json:"conflicts,omitempty"`
}

type progressInfo struct {
	Percent             int    `json:"percent"`
	BytesDone           int64  `json:"bytesDone"`
	BytesTotal          int64  `json:"bytesTotal"`
	EntriesDone         int    `json:"entriesDone"`
	EntriesTotal        int    `json:"entriesTotal"`
	CurrentEntry        string `json:"currentEntry,omitempty"`
	SpeedBytesPerSecond int64  `json:"speedBytesPerSecond"`
}

type outputInfo struct {
	Mode         string `json:"mode,omitempty"`
	ResourcePath string `json:"resourcePath,omitempty"`
	DownloadURL  string `json:"downloadUrl,omitempty"`
}

type publicJob struct {
	ID         string       `json:"id"`
	Type       string       `json:"type"`
	Status     string       `json:"status"`
	Stage      string       `json:"stage,omitempty"`
	Format     string       `json:"format,omitempty"`
	Code       string       `json:"code,omitempty"`
	Error      string       `json:"error,omitempty"`
	Progress   progressInfo `json:"progress"`
	Output     outputInfo   `json:"output,omitempty"`
	CreatedAt  time.Time    `json:"createdAt"`
	UpdatedAt  time.Time    `json:"updatedAt"`
	FinishedAt *time.Time   `json:"finishedAt,omitempty"`
}

type previewRequest struct {
	Source   sourceRef `json:"source"`
	Password string    `json:"password,omitempty"`
}

type previewEntry struct {
	ID          string     `json:"id"`
	Path        string     `json:"path"`
	Name        string     `json:"name"`
	Parent      string     `json:"parent"`
	IsDir       bool       `json:"isDir"`
	Size        int64      `json:"size"`
	ModTime     time.Time  `json:"modTime,omitempty"`
	CreatedTime *time.Time `json:"createdTime,omitempty"`
	MimeType    string     `json:"mimeType,omitempty"`
	PreviewKind string     `json:"previewKind,omitempty"`
	Encrypted   bool       `json:"encrypted,omitempty"`
}

type publicPreview struct {
	ID           string         `json:"id"`
	Format       string         `json:"format"`
	Source       sourceRef      `json:"source"`
	Entries      []previewEntry `json:"entries,omitempty"`
	TotalEntries int            `json:"totalEntries"`
	CreatedAt    time.Time      `json:"createdAt"`
	UpdatedAt    time.Time      `json:"updatedAt"`
	ExpiresAt    time.Time      `json:"expiresAt"`
}

type job struct {
	mu sync.Mutex

	ID             string
	Type           string
	Status         string
	Stage          string
	Format         string
	Code           string
	Error          string
	Authorization  string
	AuthHash       string
	DownloadToken  string
	TokenExpiresAt time.Time

	Extraction  *extractionRequest
	Compression *compressionRequest
	Output      outputInfo

	BytesDone    int64
	BytesTotal   int64
	OutputBytes  int64
	EntriesDone  int
	EntriesTotal int
	CurrentEntry string
	StartedAt    time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
	FinishedAt   *time.Time

	ctx    context.Context
	cancel context.CancelFunc
}

type previewSession struct {
	mu sync.Mutex

	ID            string
	Format        string
	Authorization string
	AuthHash      string
	Password      string
	Source        sourceRef
	Entries       []previewEntry
	EntryByID     map[string]previewEntry
	DownloadToken map[string]downloadToken
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type downloadToken struct {
	EntryID   string
	ExpiresAt time.Time
}

type server struct {
	cfg        config
	httpClient *http.Client
	sem        chan struct{}

	mu          sync.RWMutex
	jobs        map[string]*job
	previews    map[string]*previewSession
	subscribers map[int]subscriber
	nextSubID   int
}

type subscriber struct {
	authHash string
	ch       chan []byte
}

type davClient struct {
	base           *url.URL
	httpClient     *http.Client
	auth           string
	requestTimeout time.Duration
}

type davResource struct {
	SpaceID string
	Path    string
	Name    string
	IsDir   bool
	Size    int64
	ModTime time.Time
}

type archiveEntry struct {
	SpaceID string
	Path    string
	Name    string
	IsDir   bool
	Size    int64
	ModTime time.Time
}

type rarArchiveEntry struct {
	Path        string
	IsDir       bool
	Size        int64
	UnknownSize bool
	ModTime     time.Time
	CreatedTime *time.Time
	Encrypted   bool
	Solid       bool
}

type compressionPlan struct {
	entries []archiveEntry
	total   int64
}

type multistatusXML struct {
	Responses []responseXML `xml:"response"`
}

type responseXML struct {
	Href     string        `xml:"href"`
	Propstat []propstatXML `xml:"propstat"`
}

type propstatXML struct {
	Status string  `xml:"status"`
	Prop   propXML `xml:"prop"`
}

type propXML struct {
	DisplayName      string          `xml:"displayname"`
	GetContentLength string          `xml:"getcontentlength"`
	GetLastModified  string          `xml:"getlastmodified"`
	ResourceType     resourceTypeXML `xml:"resourcetype"`
}

type resourceTypeXML struct {
	Collection *struct{} `xml:"collection"`
}

func main() {
	cfg := loadConfig()
	if err := os.MkdirAll(cfg.tmpDir, 0o700); err != nil {
		log.Fatalf("create temp dir: %v", err)
	}
	if err := cleanupTmpDir(cfg.tmpDir); err != nil {
		log.Printf("cleanup temp dir: %v", err)
	}

	s, err := newServer(cfg)
	if err != nil {
		log.Fatal(err)
	}

	go s.sweepLoop()

	log.Printf("OpenCloud file archiver service listening on :%s", cfg.port)
	if err := http.ListenAndServe(":"+cfg.port, s); err != nil {
		log.Fatal(err)
	}
}

func loadConfig() config {
	return config{
		port: envString("PORT", "8080"),
		opencloudURL: firstEnv(
			"FILE_ARCHIVER_OPENCLOUD_URL",
			"ARCHIVE_OPENCLOUD_URL",
			"OPENCLOUD_URL",
		),
		tmpDir: envString(
			"FILE_ARCHIVER_TMP_DIR",
			filepath.Join(os.TempDir(), "opencloud-file-archiver"),
			"ARCHIVE_TMP_DIR",
		),
		jsonLimit:         envInt64("FILE_ARCHIVER_JSON_LIMIT_BYTES", 1<<20, "ARCHIVE_JSON_LIMIT_BYTES"),
		maxArchiveBytes:   envInt64("FILE_ARCHIVER_MAX_ARCHIVE_BYTES", 20*1000*1000*1000, "ARCHIVE_MAX_ARCHIVE_BYTES"),
		maxOutputBytes:    envInt64("FILE_ARCHIVER_MAX_OUTPUT_BYTES", 100*1000*1000*1000, "ARCHIVE_MAX_OUTPUT_BYTES"),
		maxEntryBytes:     envInt64("FILE_ARCHIVER_MAX_ENTRY_BYTES", 20*1000*1000*1000, "ARCHIVE_MAX_ENTRY_BYTES"),
		maxPreviewBytes:   envInt64("FILE_ARCHIVER_MAX_PREVIEW_BYTES", 50*1000*1000, "ARCHIVE_MAX_PREVIEW_BYTES"),
		maxEntries:        int(envInt64("FILE_ARCHIVER_MAX_ENTRIES", 100000, "ARCHIVE_MAX_ENTRIES")),
		maxConcurrentJobs: int(envInt64("FILE_ARCHIVER_MAX_CONCURRENT_JOBS", 2, "ARCHIVE_MAX_CONCURRENT_JOBS")),
		jobTTL:            envDuration("FILE_ARCHIVER_JOB_TTL", time.Hour, "ARCHIVE_JOB_TTL"),
		davRequestTimeout: envDuration("FILE_ARCHIVER_DAV_REQUEST_TIMEOUT", 6*time.Hour, "ARCHIVE_DAV_REQUEST_TIMEOUT"),
		davHeaderTimeout:  envDuration("FILE_ARCHIVER_DAV_HEADER_TIMEOUT", 30*time.Second, "ARCHIVE_DAV_HEADER_TIMEOUT"),
		downloadTokenTTL:  envDuration("FILE_ARCHIVER_DOWNLOAD_TOKEN_TTL", 10*time.Minute, "ARCHIVE_DOWNLOAD_TOKEN_TTL"),
		aesBufferLimit:    uint64(envInt64("FILE_ARCHIVER_ZIP_AES_BUFFER_LIMIT", 512*1000*1000, "ARCHIVE_ZIP_AES_BUFFER_LIMIT")),
		rarDictionarySize: envInt64("FILE_ARCHIVER_RAR_MAX_DICTIONARY_BYTES", 256*1024*1024, "ARCHIVE_RAR_MAX_DICTIONARY_BYTES"),
		rangeBlockSize:    envInt64("FILE_ARCHIVER_RANGE_BLOCK_BYTES", 1024*1024, "ARCHIVE_RANGE_BLOCK_BYTES"),
	}
}

func newServer(cfg config) (*server, error) {
	if cfg.opencloudURL == "" {
		return nil, errors.New("FILE_ARCHIVER_OPENCLOUD_URL, ARCHIVE_OPENCLOUD_URL or OPENCLOUD_URL is required")
	}
	if cfg.maxConcurrentJobs < 1 {
		cfg.maxConcurrentJobs = 1
	}
	if cfg.rangeBlockSize < 4096 {
		cfg.rangeBlockSize = 1024 * 1024
	}
	if cfg.rangeBlockSize > 64*1024*1024 {
		cfg.rangeBlockSize = 64 * 1024 * 1024
	}
	if cfg.davRequestTimeout <= 0 {
		cfg.davRequestTimeout = 6 * time.Hour
	}
	if cfg.davHeaderTimeout <= 0 {
		cfg.davHeaderTimeout = 30 * time.Second
	}
	if cfg.downloadTokenTTL <= 0 {
		cfg.downloadTokenTTL = 10 * time.Minute
	}
	if cfg.rarDictionarySize <= 0 {
		cfg.rarDictionarySize = 256 * 1024 * 1024
	}
	return &server{
		cfg:         cfg,
		httpClient:  newDAVHTTPClient(cfg),
		sem:         make(chan struct{}, cfg.maxConcurrentJobs),
		jobs:        map[string]*job{},
		previews:    map[string]*previewSession{},
		subscribers: map[int]subscriber{},
	}, nil
}

func newDAVHTTPClient(cfg config) *http.Client {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dialer.DialContext
	transport.ResponseHeaderTimeout = cfg.davHeaderTimeout
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ExpectContinueTimeout = time.Second
	transport.IdleConnTimeout = 90 * time.Second
	return &http.Client{Transport: transport}
}

func envString(name, fallback string, aliases ...string) string {
	for _, key := range append([]string{name}, aliases...) {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return fallback
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

func envInt64(name string, fallback int64, aliases ...string) int64 {
	value := ""
	for _, key := range append([]string{name}, aliases...) {
		value = os.Getenv(key)
		if value != "" {
			break
		}
	}
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(name string, fallback time.Duration, aliases ...string) time.Duration {
	value := ""
	for _, key := range append([]string{name}, aliases...) {
		value = os.Getenv(key)
		if value != "" {
			break
		}
	}
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func cleanupTmpDir(tmpDir string) error {
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "job-") &&
			!strings.HasPrefix(name, "entry-") &&
			!strings.HasPrefix(name, "archive-output-") {
			continue
		}
		if err := os.RemoveAll(filepath.Join(tmpDir, name)); err != nil {
			return err
		}
	}
	return nil
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,Accept,X-Access-Token")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	pathname := requestPath(r)
	switch {
	case r.Method == http.MethodGet && pathname == "/healthz":
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case r.Method == http.MethodPost && pathname == "/api/extractions":
		s.handleCreateExtraction(w, r)
	case r.Method == http.MethodPost && pathname == "/api/compressions":
		s.handleCreateCompression(w, r)
	case r.Method == http.MethodPost && pathname == "/api/previews":
		s.handleCreatePreview(w, r)
	case r.Method == http.MethodGet && pathname == "/api/jobs":
		s.handleListJobs(w, r)
	case r.Method == http.MethodGet && pathname == "/api/jobs/events":
		s.handleJobEvents(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(pathname, "/api/jobs/") && strings.HasSuffix(pathname, "/download"):
		s.handleDownloadJob(w, r, strings.TrimSuffix(strings.TrimPrefix(pathname, "/api/jobs/"), "/download"))
	case r.Method == http.MethodGet && strings.HasPrefix(pathname, "/api/jobs/"):
		s.handleGetJob(w, r, strings.TrimPrefix(pathname, "/api/jobs/"))
	case r.Method == http.MethodDelete && strings.HasPrefix(pathname, "/api/jobs/"):
		s.handleDeleteJob(w, r, strings.TrimPrefix(pathname, "/api/jobs/"))
	case r.Method == http.MethodPost && strings.HasPrefix(pathname, "/api/previews/") && strings.Contains(pathname, "/entries/") && strings.HasSuffix(pathname, "/download"):
		previewID, entryID := splitPreviewDownloadPath(pathname)
		s.handleCreatePreviewEntryDownload(w, r, previewID, entryID)
	case r.Method == http.MethodGet && strings.HasPrefix(pathname, "/api/previews/") && strings.Contains(pathname, "/entries/") && strings.HasSuffix(pathname, "/content"):
		previewID, entryID := splitPreviewContentPath(pathname)
		s.handlePreviewEntryContent(w, r, previewID, entryID)
	case r.Method == http.MethodGet && strings.HasPrefix(pathname, "/api/previews/") && strings.HasSuffix(pathname, "/entries"):
		s.handleListPreviewEntries(w, r, strings.TrimSuffix(strings.TrimPrefix(pathname, "/api/previews/"), "/entries"))
	case r.Method == http.MethodGet && strings.HasPrefix(pathname, "/api/previews/"):
		s.handleGetPreview(w, r, strings.TrimPrefix(pathname, "/api/previews/"))
	case r.Method == http.MethodDelete && strings.HasPrefix(pathname, "/api/previews/"):
		s.handleDeletePreview(w, r, strings.TrimPrefix(pathname, "/api/previews/"))
	case r.Method == http.MethodGet && strings.HasPrefix(pathname, "/api/extractions/"):
		s.handleGetJob(w, r, strings.TrimPrefix(pathname, "/api/extractions/"))
	case r.Method == http.MethodDelete && strings.HasPrefix(pathname, "/api/extractions/"):
		s.handleDeleteJob(w, r, strings.TrimPrefix(pathname, "/api/extractions/"))
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "NOT_FOUND", "error": "Not found"})
	}
}

func requestPath(r *http.Request) string {
	pathname := r.URL.Path
	if pathname == "/archive" {
		return "/"
	}
	if strings.HasPrefix(pathname, "/archive/") {
		return strings.TrimPrefix(pathname, "/archive")
	}
	return pathname
}

func (s *server) handleCreateExtraction(w http.ResponseWriter, r *http.Request) {
	auth, err := getAuthHeader(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var input extractionRequest
	if err := readJSON(r, s.cfg.jsonLimit, &input); err != nil {
		writeError(w, err)
		return
	}
	if err := validateExtractionRequest(&input); err != nil {
		writeError(w, err)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	j := &job{
		ID:            randomID(),
		Type:          jobExtraction,
		Status:        statusQueued,
		Stage:         "queued",
		Format:        detectArchiveKind(input.Source.Name, input.Source.MimeType),
		Authorization: auth,
		AuthHash:      hashAuth(auth),
		Extraction:    &input,
		Output:        outputInfo{Mode: outputSave, ResourcePath: input.Destination.FolderPath},
		BytesTotal:    maxInt64(input.Source.Size, 0),
		CreatedAt:     time.Now(),
		UpdatedAt:     time.Now(),
		ctx:           ctx,
		cancel:        cancel,
	}
	s.addJob(j)
	go s.runExtractionJob(j)
	writeJSON(w, http.StatusAccepted, s.publicJob(j))
}

func (s *server) handleCreateCompression(w http.ResponseWriter, r *http.Request) {
	auth, err := getAuthHeader(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var input compressionRequest
	if err := readJSON(r, s.cfg.jsonLimit, &input); err != nil {
		writeError(w, err)
		return
	}
	if err := validateCompressionRequest(&input); err != nil {
		writeError(w, err)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	j := &job{
		ID:            randomID(),
		Type:          jobCompression,
		Status:        statusQueued,
		Stage:         "queued",
		Format:        input.Format,
		Authorization: auth,
		AuthHash:      hashAuth(auth),
		Compression:   &input,
		Output:        compressionOutputInfo(input),
		CreatedAt:     time.Now(),
		UpdatedAt:     time.Now(),
		ctx:           ctx,
		cancel:        cancel,
	}
	if input.Output.Mode == outputDownload {
		j.DownloadToken = randomID()
		j.TokenExpiresAt = time.Now().Add(s.cfg.downloadTokenTTL)
		j.Output.DownloadURL = downloadJobURL(j)
	}
	s.addJob(j)
	if input.Output.Mode == outputSave {
		go s.runCompressionSaveJob(j)
	}
	writeJSON(w, http.StatusAccepted, s.publicJob(j))
}

func (s *server) handleCreatePreview(w http.ResponseWriter, r *http.Request) {
	auth, err := getAuthHeader(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var input previewRequest
	if err := readJSON(r, s.cfg.jsonLimit, &input); err != nil {
		writeError(w, err)
		return
	}
	if err := validatePreviewRequest(&input); err != nil {
		writeError(w, err)
		return
	}

	dc, err := s.newDAVClient(auth)
	if err != nil {
		writeError(w, err)
		return
	}
	var entries []previewEntry
	if err := s.withWorker(r.Context(), func() error {
		var err error
		entries, err = s.indexPreviewArchive(r.Context(), dc, input)
		return err
	}); err != nil {
		writeError(w, err)
		return
	}
	if input.Password == "" && previewContainsEncryptedEntries(entries) {
		writeError(w, newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password is required"))
		return
	}

	now := time.Now()
	p := &previewSession{
		ID:            randomID(),
		Format:        detectArchiveKind(input.Source.Name, input.Source.MimeType),
		Authorization: auth,
		AuthHash:      hashAuth(auth),
		Password:      input.Password,
		Source:        input.Source,
		Entries:       entries,
		EntryByID:     map[string]previewEntry{},
		DownloadToken: map[string]downloadToken{},
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	for _, entry := range entries {
		p.EntryByID[entry.ID] = entry
	}
	s.addPreview(p)
	writeJSON(w, http.StatusCreated, s.publicPreview(p, entries))
}

func (s *server) handleGetPreview(w http.ResponseWriter, r *http.Request, encodedID string) {
	p, err := s.getAuthorizedPreview(r, encodedID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.publicPreview(p, nil))
}

func (s *server) handleListPreviewEntries(w http.ResponseWriter, r *http.Request, encodedID string) {
	p, err := s.getAuthorizedPreview(r, encodedID)
	if err != nil {
		writeError(w, err)
		return
	}
	parent, err := normalizePreviewListPath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, err)
		return
	}
	entries := p.entriesByParent(parent)
	writeJSON(w, http.StatusOK, map[string]any{
		"preview": s.publicPreview(p, nil),
		"path":    parent,
		"entries": entries,
	})
}

func (s *server) handleDeletePreview(w http.ResponseWriter, r *http.Request, encodedID string) {
	p, err := s.getAuthorizedPreview(r, encodedID)
	if err != nil {
		writeError(w, err)
		return
	}
	s.mu.Lock()
	delete(s.previews, p.ID)
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleCreatePreviewEntryDownload(w http.ResponseWriter, r *http.Request, encodedPreviewID, encodedEntryID string) {
	p, err := s.getAuthorizedPreview(r, encodedPreviewID)
	if err != nil {
		writeError(w, err)
		return
	}
	entryID, _ := url.PathUnescape(encodedEntryID)
	entry, ok := p.entryByID(entryID)
	if !ok {
		writeError(w, newError(http.StatusNotFound, "NOT_FOUND", "Archive entry not found"))
		return
	}
	if entry.IsDir {
		writeError(w, newError(http.StatusBadRequest, "BAD_REQUEST", "Archive entry is a directory"))
		return
	}
	if s.cfg.maxEntryBytes > 0 && entry.Size > s.cfg.maxEntryBytes {
		writeError(w, newError(http.StatusRequestEntityTooLarge, "ENTRY_TOO_LARGE", "Archive entry exceeds configured download size limit"))
		return
	}
	token := randomID()
	p.addDownloadToken(token, entry.ID, time.Now().Add(s.cfg.downloadTokenTTL))
	writeJSON(w, http.StatusCreated, map[string]string{
		"downloadUrl": previewEntryDownloadURL(p.ID, entry.ID, token),
	})
}

func (s *server) handlePreviewEntryContent(w http.ResponseWriter, r *http.Request, encodedPreviewID, encodedEntryID string) {
	p, err := s.getPreviewForEntryContent(r, encodedPreviewID, encodedEntryID)
	if err != nil {
		writeError(w, err)
		return
	}
	entryID, _ := url.PathUnescape(encodedEntryID)
	entry, ok := p.entryByID(entryID)
	if !ok {
		writeError(w, newError(http.StatusNotFound, "NOT_FOUND", "Archive entry not found"))
		return
	}
	if entry.IsDir {
		writeError(w, newError(http.StatusBadRequest, "BAD_REQUEST", "Archive entry is a directory"))
		return
	}
	download := r.URL.Query().Get("download") == "1"
	limit := s.cfg.maxPreviewBytes
	code := "PREVIEW_TOO_LARGE"
	message := "Archive entry exceeds configured preview size limit"
	if download {
		limit = s.cfg.maxEntryBytes
		code = "ENTRY_TOO_LARGE"
		message = "Archive entry exceeds configured download size limit"
	}
	if limit > 0 && entry.Size > limit {
		writeError(w, newError(http.StatusRequestEntityTooLarge, code, message))
		return
	}

	var content *previewContentFile
	if err := s.withWorker(r.Context(), func() error {
		var err error
		content, err = s.spoolPreviewEntryContent(r.Context(), p, entry, limit, code)
		return err
	}); err != nil {
		writeError(w, err)
		return
	}
	defer content.cleanup()

	f, err := os.Open(content.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	defer f.Close()

	contentType := entry.MimeType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	if download {
		w.Header().Set("Content-Disposition", contentDisposition(entry.Name))
	} else {
		w.Header().Set("Content-Disposition", inlineContentDisposition(entry.Name))
	}
	w.Header().Set("Content-Length", strconv.FormatInt(content.Size, 10))
	if _, err := io.CopyBuffer(contextWriter{ctx: r.Context(), w: w}, f, make([]byte, 1024*1024)); err != nil {
		log.Printf("preview response failed: preview=%s entry=%s err=%v", p.ID, entry.ID, err)
	}
}

func (s *server) handleGetJob(w http.ResponseWriter, r *http.Request, id string) {
	j, err := s.getAuthorizedJob(r, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.publicJob(j))
}

func (s *server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	auth, err := getAuthHeader(r)
	if err != nil {
		writeError(w, err)
		return
	}
	authHash := hashAuth(auth)
	s.mu.RLock()
	jobs := make([]publicJob, 0)
	for _, j := range s.jobs {
		if j.AuthHash == authHash {
			jobs = append(jobs, s.publicJob(j))
		}
	}
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

func (s *server) handleDeleteJob(w http.ResponseWriter, r *http.Request, id string) {
	j, err := s.getAuthorizedJob(r, id)
	if err != nil {
		writeError(w, err)
		return
	}
	j.mu.Lock()
	terminal := j.Status == statusSucceeded || j.Status == statusFailed || j.Status == statusCancelled
	j.mu.Unlock()
	if terminal {
		payload := s.publicJob(j)
		s.mu.Lock()
		if s.jobs[j.ID] == j {
			delete(s.jobs, j.ID)
		}
		s.mu.Unlock()
		j.cancel()
		writeJSON(w, http.StatusOK, payload)
		return
	}
	j.cancel()
	s.setJob(j, func(j *job) {
		if j.Status == statusQueued || j.Status == statusRunning {
			j.Status = statusCancelled
			j.Stage = "cancelled"
			now := time.Now()
			j.FinishedAt = &now
		}
	})
	writeJSON(w, http.StatusOK, s.publicJob(j))
}

func (s *server) handleJobEvents(w http.ResponseWriter, r *http.Request) {
	auth, err := getAuthHeader(r)
	if err != nil {
		writeError(w, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, newError(http.StatusInternalServerError, "SSE_UNAVAILABLE", "Streaming is not available"))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	sub := subscriber{authHash: hashAuth(auth), ch: make(chan []byte, 32)}
	id := s.addSubscriber(sub)
	defer s.removeSubscriber(id)

	_, _ = io.WriteString(w, ": connected\n\n")
	s.mu.RLock()
	for _, j := range s.jobs {
		if j.AuthHash == sub.authHash {
			payload, _ := json.Marshal(s.publicJob(j))
			_, _ = fmt.Fprintf(w, "event: job\ndata: %s\n\n", payload)
		}
	}
	s.mu.RUnlock()
	flusher.Flush()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		case payload := <-sub.ch:
			_, _ = fmt.Fprintf(w, "event: job\ndata: %s\n\n", payload)
			flusher.Flush()
		}
	}
}

func (s *server) handleDownloadJob(w http.ResponseWriter, r *http.Request, id string) {
	j, err := s.getDownloadJob(r, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if j.Type != jobCompression || j.Compression == nil || j.Compression.Output.Mode != outputDownload {
		writeError(w, newError(http.StatusBadRequest, "NOT_DOWNLOAD_JOB", "Job is not a downloadable compression"))
		return
	}
	if !s.markDownloadStarting(j) {
		writeError(w, newError(http.StatusConflict, "JOB_ALREADY_STARTED", "Download job already started"))
		return
	}
	defer j.cancel()

	filename := archiveOutputName(*j.Compression)
	w.Header().Set("Content-Type", archiveContentType(j.Format))
	w.Header().Set("Content-Disposition", contentDisposition(filename))
	w.Header().Set("Content-Transfer-Encoding", "binary")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	j.mu.Lock()
	j.ctx, j.cancel = ctx, cancel
	j.mu.Unlock()

	writer := io.Writer(w)
	if s.cfg.maxOutputBytes > 0 {
		writer = &limitWriter{
			ctx:       ctx,
			w:         writer,
			maxBytes:  s.cfg.maxOutputBytes,
			limitCode: "OUTPUT_TOO_LARGE",
		}
	}

	if err := s.withWorker(ctx, func() error {
		return s.runCompressionToWriter(j, writer)
	}); err != nil {
		s.failJob(j, err)
		return
	}
	s.finishJob(j, outputInfo{Mode: outputDownload, DownloadURL: downloadJobURL(j)})
}

func (s *server) runExtractionJob(j *job) {
	err := s.withWorker(j.ctx, func() error {
		return s.extractArchive(j)
	})
	if err != nil {
		if errors.Is(err, context.Canceled) {
			s.cancelJob(j)
			return
		}
		s.failJob(j, err)
	}
}

func (s *server) runCompressionSaveJob(j *job) {
	err := s.withWorker(j.ctx, func() error {
		return s.compressToSavedFile(j)
	})
	if err != nil {
		if errors.Is(err, context.Canceled) {
			s.cancelJob(j)
			return
		}
		s.failJob(j, err)
	}
}

func (s *server) withWorker(ctx context.Context, fn func() error) error {
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return ctx.Err()
	}
	return fn()
}

func (s *server) extractArchive(j *job) error {
	req := j.Extraction
	if req == nil {
		return newError(http.StatusBadRequest, "BAD_JOB", "Missing extraction request")
	}
	dc, err := s.newDAVClient(j.Authorization)
	if err != nil {
		return err
	}

	s.setJob(j, func(j *job) {
		j.Status = statusRunning
		j.Stage = "opening"
		j.StartedAt = time.Now()
	})
	switch detectArchiveKind(req.Source.Name, req.Source.MimeType) {
	case "zip":
		var size int64
		size, err = s.prepareRandomAccessSource(j, dc, req.Source)
		if err != nil {
			return err
		}
		reader := dc.readerAt(j.ctx, req.Source.SpaceID, req.Source.Path, size, s.cfg.rangeBlockSize, func(n int64) {
			s.addBytesDone(j, n)
		})
		err = s.extractZip(j, dc, reader, size)
	case "tar":
		err = s.extractTarFromWebDAV(j, dc, false)
	case "tar.gz":
		err = s.extractTarFromWebDAV(j, dc, true)
	case "gz":
		err = s.extractGzipSingleFromWebDAV(j, dc)
	case "7z":
		var size int64
		size, err = s.prepareRandomAccessSource(j, dc, req.Source)
		if err != nil {
			return err
		}
		reader := dc.readerAt(j.ctx, req.Source.SpaceID, req.Source.Path, size, s.cfg.rangeBlockSize, func(n int64) {
			s.addBytesDone(j, n)
		})
		err = s.extractSevenZip(j, dc, reader, size)
	case "rar":
		var size int64
		size, err = s.prepareRandomAccessSource(j, dc, req.Source)
		if err != nil {
			return err
		}
		reader := dc.readerAt(j.ctx, req.Source.SpaceID, req.Source.Path, size, s.cfg.rangeBlockSize, func(n int64) {
			s.addBytesDone(j, n)
		})
		err = s.extractRar(j, dc, reader, size)
	default:
		err = newError(http.StatusBadRequest, "UNSUPPORTED_ARCHIVE", "Unsupported archive type")
	}
	if err != nil {
		return err
	}
	s.finishJob(j, outputInfo{Mode: outputSave, ResourcePath: req.Destination.FolderPath})
	return nil
}

func (s *server) prepareRandomAccessSource(j *job, dc *davClient, src sourceRef) (int64, error) {
	info, err := dc.stat(j.ctx, src.SpaceID, src.Path)
	if err != nil {
		return 0, err
	}
	if info.Size <= 0 {
		return 0, newError(http.StatusBadRequest, "ARCHIVE_SIZE_UNKNOWN", "Archive size is required for random access extraction")
	}
	if s.cfg.maxArchiveBytes > 0 && info.Size > s.cfg.maxArchiveBytes {
		return 0, newError(http.StatusRequestEntityTooLarge, "ARCHIVE_TOO_LARGE", "Archive exceeds configured size limit")
	}
	s.setJob(j, func(j *job) {
		j.BytesTotal = info.Size
		j.Stage = "extracting"
	})
	return info.Size, nil
}

func (s *server) archiveStreamFromWebDAV(j *job, dc *davClient, src sourceRef) (io.ReadCloser, error) {
	body, size, err := dc.get(j.ctx, src.SpaceID, src.Path)
	if err != nil {
		return nil, err
	}
	if s.cfg.maxArchiveBytes > 0 && size > s.cfg.maxArchiveBytes {
		_ = body.Close()
		return nil, newError(http.StatusRequestEntityTooLarge, "ARCHIVE_TOO_LARGE", "Archive exceeds configured size limit")
	}
	if size > 0 {
		s.setJob(j, func(j *job) { j.BytesTotal = size })
	}

	r := &limitProgressReader{
		ctx:      j.ctx,
		r:        body,
		maxBytes: s.cfg.maxArchiveBytes,
		onBytes: func(n int64) error {
			s.addBytesDone(j, n)
			return nil
		},
		limitCode: "ARCHIVE_TOO_LARGE",
	}
	return readCloser{Reader: r, Closer: body}, nil
}

func (s *server) indexPreviewArchive(ctx context.Context, dc *davClient, req previewRequest) ([]previewEntry, error) {
	switch detectArchiveKind(req.Source.Name, req.Source.MimeType) {
	case "zip":
		size, err := s.preparePreviewRandomAccessSource(ctx, dc, req.Source)
		if err != nil {
			return nil, err
		}
		reader := dc.readerAt(ctx, req.Source.SpaceID, req.Source.Path, size, s.cfg.rangeBlockSize, nil)
		return s.indexZipPreview(reader, size, req.Password)
	case "tar":
		body, err := s.previewArchiveStream(ctx, dc, req.Source)
		if err != nil {
			return nil, err
		}
		defer body.Close()
		return s.indexTarPreview(ctx, body, false)
	case "tar.gz":
		body, err := s.previewArchiveStream(ctx, dc, req.Source)
		if err != nil {
			return nil, err
		}
		defer body.Close()
		return s.indexTarPreview(ctx, body, true)
	case "gz":
		body, err := s.previewArchiveStream(ctx, dc, req.Source)
		if err != nil {
			return nil, err
		}
		defer body.Close()
		return s.indexGzipPreview(body, req.Source)
	case "7z":
		size, err := s.preparePreviewRandomAccessSource(ctx, dc, req.Source)
		if err != nil {
			return nil, err
		}
		reader := dc.readerAt(ctx, req.Source.SpaceID, req.Source.Path, size, s.cfg.rangeBlockSize, nil)
		return s.indexSevenZipPreview(reader, size, req.Password)
	case "rar":
		size, err := s.preparePreviewRandomAccessSource(ctx, dc, req.Source)
		if err != nil {
			return nil, err
		}
		reader := dc.readerAt(ctx, req.Source.SpaceID, req.Source.Path, size, s.cfg.rangeBlockSize, nil)
		return s.indexRarPreview(ctx, reader, size, req.Password)
	default:
		return nil, newError(http.StatusBadRequest, "UNSUPPORTED_ARCHIVE", "Unsupported archive type")
	}
}

func (s *server) preparePreviewRandomAccessSource(ctx context.Context, dc *davClient, src sourceRef) (int64, error) {
	info, err := dc.stat(ctx, src.SpaceID, src.Path)
	if err != nil {
		return 0, err
	}
	if info.Size <= 0 {
		return 0, newError(http.StatusBadRequest, "ARCHIVE_SIZE_UNKNOWN", "Archive size is required for random access preview")
	}
	if s.cfg.maxArchiveBytes > 0 && info.Size > s.cfg.maxArchiveBytes {
		return 0, newError(http.StatusRequestEntityTooLarge, "ARCHIVE_TOO_LARGE", "Archive exceeds configured size limit")
	}
	return info.Size, nil
}

func (s *server) previewArchiveStream(ctx context.Context, dc *davClient, src sourceRef) (io.ReadCloser, error) {
	body, size, err := dc.get(ctx, src.SpaceID, src.Path)
	if err != nil {
		return nil, err
	}
	if s.cfg.maxArchiveBytes > 0 && size > s.cfg.maxArchiveBytes {
		_ = body.Close()
		return nil, newError(http.StatusRequestEntityTooLarge, "ARCHIVE_TOO_LARGE", "Archive exceeds configured size limit")
	}
	r := &limitProgressReader{
		ctx:       ctx,
		r:         body,
		maxBytes:  s.cfg.maxArchiveBytes,
		limitCode: "ARCHIVE_TOO_LARGE",
	}
	return readCloser{Reader: r, Closer: body}, nil
}

func (s *server) indexZipPreview(archive io.ReaderAt, size int64, password string) ([]previewEntry, error) {
	zr, err := yzip.NewReader(archive, size)
	if err != nil {
		return nil, archiveReadError(err)
	}
	if len(zr.File) > s.cfg.maxEntries {
		return nil, newError(http.StatusRequestEntityTooLarge, "TOO_MANY_ENTRIES", "Archive contains too many entries")
	}
	entries := make([]previewEntry, 0, len(zr.File))
	verifiedPassword := false
	for _, f := range zr.File {
		entryPath, err := safeArchivePath(f.Name)
		if err != nil {
			return nil, newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", f.Name, err))
		}
		info := f.FileInfo()
		isDir := info.IsDir()
		if !isDir && info.Mode().Type() != 0 {
			return nil, newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", "ZIP entry is not a regular file")
		}
		if f.IsEncrypted() {
			if !zipHasWinZipAES(f.Extra) {
				return nil, newError(http.StatusBadRequest, "UNSUPPORTED_ENCRYPTION", "ZIP standard encryption is disabled")
			}
			if password != "" && !verifiedPassword && !isDir {
				f.SetPassword(password)
				rc, err := f.Open()
				if err != nil {
					return nil, zipReadError(err)
				}
				_, copyErr := io.CopyN(io.Discard, rc, 1)
				closeErr := rc.Close()
				if copyErr != nil && !errors.Is(copyErr, io.EOF) {
					return nil, zipReadError(copyErr)
				}
				if closeErr != nil {
					return nil, zipReadError(closeErr)
				}
				verifiedPassword = true
			}
		}
		entries = append(entries, previewEntry{
			Path:        entryPath,
			IsDir:       isDir,
			Size:        int64(f.UncompressedSize64),
			ModTime:     info.ModTime(),
			CreatedTime: optionalTime(zipCreatedTime(f.Extra)),
			Encrypted:   f.IsEncrypted(),
		})
	}
	return finalizePreviewEntries(entries), nil
}

func (s *server) indexSevenZipPreview(archive io.ReaderAt, size int64, password string) ([]previewEntry, error) {
	var zr *sevenzip.Reader
	var err error
	if password == "" {
		zr, err = sevenzip.NewReader(archive, size)
	} else {
		zr, err = sevenzip.NewReaderWithPassword(archive, size, password)
	}
	if err != nil {
		if password == "" {
			return nil, newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password may be required")
		}
		return nil, archiveReadError(err)
	}
	if len(zr.File) > s.cfg.maxEntries {
		return nil, newError(http.StatusRequestEntityTooLarge, "TOO_MANY_ENTRIES", "Archive contains too many entries")
	}
	entries := make([]previewEntry, 0, len(zr.File))
	for _, f := range zr.File {
		entryPath, err := safeArchivePath(f.Name)
		if err != nil {
			return nil, newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", f.Name, err))
		}
		info := f.FileInfo()
		isDir := info.IsDir()
		if !isDir && info.Mode().Type() != 0 {
			return nil, newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", "7z entry is not a regular file")
		}
		entries = append(entries, previewEntry{
			Path:        entryPath,
			IsDir:       isDir,
			Size:        info.Size(),
			ModTime:     info.ModTime(),
			CreatedTime: optionalTime(f.Created),
		})
	}
	return finalizePreviewEntries(entries), nil
}

func (s *server) indexRarPreview(ctx context.Context, archive io.ReaderAt, size int64, password string) ([]previewEntry, error) {
	rarEntries, err := s.scanRarArchive(ctx, archive, size, password, password != "")
	if err != nil {
		return nil, err
	}
	entries := make([]previewEntry, 0, len(rarEntries))
	for _, entry := range rarEntries {
		entries = append(entries, previewEntry{
			Path:        entry.Path,
			IsDir:       entry.IsDir,
			Size:        entry.Size,
			ModTime:     entry.ModTime,
			CreatedTime: entry.CreatedTime,
			Encrypted:   entry.Encrypted,
		})
	}
	return finalizePreviewEntries(entries), nil
}

func (s *server) scanRarArchive(ctx context.Context, archive io.ReaderAt, size int64, password string, verifyEncrypted bool) ([]rarArchiveEntry, error) {
	rr, err := s.newRarReader(io.NewSectionReader(archive, 0, size), password)
	if err != nil {
		return nil, err
	}
	entries := make([]rarArchiveEntry, 0)
	verifiedEncrypted := false
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		h, err := rr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, rarReadError(err, password)
		}
		if len(entries) >= s.cfg.maxEntries {
			return nil, newError(http.StatusRequestEntityTooLarge, "TOO_MANY_ENTRIES", "Archive contains too many entries")
		}
		entry, err := rarArchiveEntryFromHeader(h)
		if err != nil {
			return nil, err
		}
		if !entry.IsDir && !entry.UnknownSize && s.cfg.maxEntryBytes > 0 && entry.Size > s.cfg.maxEntryBytes {
			return nil, newError(http.StatusRequestEntityTooLarge, "ENTRY_TOO_LARGE", "RAR entry exceeds configured size limit")
		}
		entries = append(entries, entry)
		if verifyEncrypted && !verifiedEncrypted && entry.Encrypted && !entry.IsDir && password != "" {
			_, copyErr := io.CopyN(io.Discard, rr, 1)
			if copyErr != nil && !errors.Is(copyErr, io.EOF) {
				return nil, rarReadError(copyErr, password)
			}
			verifiedEncrypted = true
		}
	}
	return entries, nil
}

func (s *server) newRarReader(r io.Reader, password string) (*rardecode.Reader, error) {
	opts := []rardecode.Option{rardecode.MaxDictionarySize(s.cfg.rarDictionarySize)}
	if password != "" {
		opts = append(opts, rardecode.Password(password))
	}
	rr, err := rardecode.NewReader(r, opts...)
	if err != nil {
		return nil, rarReadError(err, password)
	}
	return rr, nil
}

func rarArchiveEntryFromHeader(h *rardecode.FileHeader) (rarArchiveEntry, error) {
	entryPath, err := safeArchivePath(h.Name)
	if err != nil {
		return rarArchiveEntry{}, newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", h.Name, err))
	}
	mode := h.Mode()
	if !h.IsDir && mode.Type() != 0 {
		return rarArchiveEntry{}, newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", "RAR entry is not a regular file")
	}
	size := h.UnPackedSize
	if h.UnKnownSize {
		size = -1
	}
	return rarArchiveEntry{
		Path:        entryPath,
		IsDir:       h.IsDir,
		Size:        size,
		UnknownSize: h.UnKnownSize,
		ModTime:     h.ModificationTime,
		CreatedTime: optionalTime(h.CreationTime),
		Encrypted:   h.Encrypted || h.HeaderEncrypted,
		Solid:       h.Solid,
	}, nil
}

func (s *server) indexTarPreview(ctx context.Context, src io.Reader, gzipped bool) ([]previewEntry, error) {
	var r io.Reader = src
	var gz *gzip.Reader
	if gzipped {
		var err error
		gz, err = gzip.NewReader(src)
		if err != nil {
			return nil, archiveReadError(err)
		}
		defer gz.Close()
		r = gz
	}
	tr := tar.NewReader(r)
	var entries []previewEntry
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, archiveReadError(err)
		}
		if len(entries) >= s.cfg.maxEntries {
			return nil, newError(http.StatusRequestEntityTooLarge, "TOO_MANY_ENTRIES", "Archive contains too many entries")
		}
		entryPath, err := safeArchivePath(h.Name)
		if err != nil {
			return nil, newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", h.Name, err))
		}
		switch h.Typeflag {
		case tar.TypeDir:
			entries = append(entries, previewEntry{Path: entryPath, IsDir: true, ModTime: h.ModTime})
		case tar.TypeReg, tar.TypeRegA:
			entries = append(entries, previewEntry{Path: entryPath, Size: h.Size, ModTime: h.ModTime})
		default:
			return nil, newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", fmt.Sprintf("Unsupported tar entry type %q", h.Typeflag))
		}
	}
	return finalizePreviewEntries(entries), nil
}

func (s *server) indexGzipPreview(src io.Reader, source sourceRef) ([]previewEntry, error) {
	gz, err := gzip.NewReader(src)
	if err != nil {
		return nil, archiveReadError(err)
	}
	defer gz.Close()
	name := strings.TrimSuffix(strings.TrimSuffix(source.Name, ".gz"), ".GZ")
	if gz.Name != "" {
		if _, err := safeArchivePath(gz.Name); err == nil {
			name = path.Base(gz.Name)
		}
	}
	if name == "" || name == source.Name {
		name = "archive-output"
	}
	entryPath, err := safeArchivePath(name)
	if err != nil {
		return nil, err
	}
	return finalizePreviewEntries([]previewEntry{{
		Path:    entryPath,
		Size:    -1,
		ModTime: gz.ModTime,
	}}), nil
}

func (s *server) spoolPreviewEntryContent(ctx context.Context, p *previewSession, entry previewEntry, maxBytes int64, limitCode string) (*previewContentFile, error) {
	f, err := os.CreateTemp(s.cfg.tmpDir, "preview-"+p.ID+"-")
	if err != nil {
		return nil, err
	}
	content := &previewContentFile{Path: f.Name()}
	writeErr := s.writePreviewEntryContent(ctx, f, p, entry, maxBytes, limitCode)
	closeErr := f.Close()
	if writeErr != nil {
		content.cleanup()
		return nil, writeErr
	}
	if closeErr != nil {
		content.cleanup()
		return nil, closeErr
	}
	stat, err := os.Stat(content.Path)
	if err != nil {
		content.cleanup()
		return nil, err
	}
	content.Size = stat.Size()
	return content, nil
}

func (s *server) writePreviewEntryContent(ctx context.Context, w io.Writer, p *previewSession, entry previewEntry, maxBytes int64, limitCode string) error {
	dc, err := s.newDAVClient(p.Authorization)
	if err != nil {
		return err
	}
	switch p.Format {
	case "zip":
		size, err := s.preparePreviewRandomAccessSource(ctx, dc, p.Source)
		if err != nil {
			return err
		}
		reader := dc.readerAt(ctx, p.Source.SpaceID, p.Source.Path, size, s.cfg.rangeBlockSize, nil)
		return s.writeZipPreviewEntry(ctx, w, reader, size, p.Password, entry, maxBytes, limitCode)
	case "7z":
		size, err := s.preparePreviewRandomAccessSource(ctx, dc, p.Source)
		if err != nil {
			return err
		}
		reader := dc.readerAt(ctx, p.Source.SpaceID, p.Source.Path, size, s.cfg.rangeBlockSize, nil)
		return s.writeSevenZipPreviewEntry(ctx, w, reader, size, p.Password, entry, maxBytes, limitCode)
	case "rar":
		size, err := s.preparePreviewRandomAccessSource(ctx, dc, p.Source)
		if err != nil {
			return err
		}
		reader := dc.readerAt(ctx, p.Source.SpaceID, p.Source.Path, size, s.cfg.rangeBlockSize, nil)
		return s.writeRarPreviewEntry(ctx, w, reader, size, p.Password, entry, maxBytes, limitCode)
	case "tar":
		body, err := s.previewArchiveStream(ctx, dc, p.Source)
		if err != nil {
			return err
		}
		defer body.Close()
		return s.writeTarPreviewEntry(ctx, w, body, false, entry, maxBytes, limitCode)
	case "tar.gz":
		body, err := s.previewArchiveStream(ctx, dc, p.Source)
		if err != nil {
			return err
		}
		defer body.Close()
		return s.writeTarPreviewEntry(ctx, w, body, true, entry, maxBytes, limitCode)
	case "gz":
		body, err := s.previewArchiveStream(ctx, dc, p.Source)
		if err != nil {
			return err
		}
		defer body.Close()
		return s.writeGzipPreviewEntry(ctx, w, body, entry, maxBytes, limitCode)
	default:
		return newError(http.StatusBadRequest, "UNSUPPORTED_ARCHIVE", "Unsupported archive type")
	}
}

func (s *server) writeZipPreviewEntry(ctx context.Context, w io.Writer, archive io.ReaderAt, size int64, password string, entry previewEntry, maxBytes int64, limitCode string) error {
	zr, err := yzip.NewReader(archive, size)
	if err != nil {
		return archiveReadError(err)
	}
	for _, f := range zr.File {
		entryPath, err := safeArchivePath(f.Name)
		if err != nil {
			return newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", f.Name, err))
		}
		if entryPath != entry.Path || f.FileInfo().IsDir() {
			continue
		}
		if f.FileInfo().Mode().Type() != 0 {
			return newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", "ZIP entry is not a regular file")
		}
		if f.IsEncrypted() {
			if !zipHasWinZipAES(f.Extra) {
				return newError(http.StatusBadRequest, "UNSUPPORTED_ENCRYPTION", "ZIP standard encryption is disabled")
			}
			if password == "" {
				return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password is required")
			}
			f.SetPassword(password)
			f.DeferAuth = f.CompressedSize64 > s.cfg.aesBufferLimit
		}
		rc, err := f.Open()
		if err != nil {
			return zipReadError(err)
		}
		copyErr := s.copyPreviewContent(ctx, w, rc, maxBytes, limitCode)
		closeErr := rc.Close()
		if copyErr != nil {
			return copyErr
		}
		return zipReadError(closeErr)
	}
	return newError(http.StatusNotFound, "NOT_FOUND", "Archive entry not found")
}

func (s *server) writeSevenZipPreviewEntry(ctx context.Context, w io.Writer, archive io.ReaderAt, size int64, password string, entry previewEntry, maxBytes int64, limitCode string) error {
	var zr *sevenzip.Reader
	var err error
	if password == "" {
		zr, err = sevenzip.NewReader(archive, size)
	} else {
		zr, err = sevenzip.NewReaderWithPassword(archive, size, password)
	}
	if err != nil {
		if password == "" {
			return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password may be required")
		}
		return archiveReadError(err)
	}
	for _, f := range zr.File {
		entryPath, err := safeArchivePath(f.Name)
		if err != nil {
			return newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", f.Name, err))
		}
		info := f.FileInfo()
		if entryPath != entry.Path || info.IsDir() {
			continue
		}
		if info.Mode().Type() != 0 {
			return newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", "7z entry is not a regular file")
		}
		rc, err := f.Open()
		if err != nil {
			if password == "" {
				return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password may be required")
			}
			return archiveReadError(err)
		}
		copyErr := s.copyPreviewContent(ctx, w, rc, maxBytes, limitCode)
		closeErr := rc.Close()
		if copyErr != nil {
			return copyErr
		}
		return archiveReadError(closeErr)
	}
	return newError(http.StatusNotFound, "NOT_FOUND", "Archive entry not found")
}

func (s *server) writeRarPreviewEntry(ctx context.Context, w io.Writer, archive io.ReaderAt, size int64, password string, entry previewEntry, maxBytes int64, limitCode string) error {
	rr, err := s.newRarReader(io.NewSectionReader(archive, 0, size), password)
	if err != nil {
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := rr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return rarReadError(err, password)
		}
		rarEntry, err := rarArchiveEntryFromHeader(h)
		if err != nil {
			return err
		}
		if rarEntry.Path != entry.Path {
			if rarEntry.Solid && !rarEntry.IsDir {
				if err := discardRarEntry(ctx, rr, s.cfg.maxEntryBytes, "ENTRY_TOO_LARGE"); err != nil {
					return rarStreamError(err, password)
				}
			}
			continue
		}
		if rarEntry.IsDir {
			return newError(http.StatusBadRequest, "BAD_REQUEST", "Archive entry is a directory")
		}
		if password == "" && rarEntry.Encrypted {
			return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password is required")
		}
		if maxBytes > 0 && !rarEntry.UnknownSize && rarEntry.Size > maxBytes {
			return newError(http.StatusRequestEntityTooLarge, limitCode, "Archive entry exceeds configured size limit")
		}
		if err := s.copyPreviewContent(ctx, w, rr, maxBytes, limitCode); err != nil {
			return rarStreamError(err, password)
		}
		return nil
	}
	return newError(http.StatusNotFound, "NOT_FOUND", "Archive entry not found")
}

func (s *server) writeTarPreviewEntry(ctx context.Context, w io.Writer, src io.Reader, gzipped bool, entry previewEntry, maxBytes int64, limitCode string) error {
	var r io.Reader = src
	var gz *gzip.Reader
	if gzipped {
		var err error
		gz, err = gzip.NewReader(src)
		if err != nil {
			return archiveReadError(err)
		}
		defer gz.Close()
		r = gz
	}
	tr := tar.NewReader(r)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return archiveReadError(err)
		}
		entryPath, err := safeArchivePath(h.Name)
		if err != nil {
			return newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", h.Name, err))
		}
		if entryPath != entry.Path {
			continue
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			return newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", "tar entry is not a regular file")
		}
		return s.copyPreviewContent(ctx, w, tr, maxBytes, limitCode)
	}
	return newError(http.StatusNotFound, "NOT_FOUND", "Archive entry not found")
}

func (s *server) writeGzipPreviewEntry(ctx context.Context, w io.Writer, src io.Reader, entry previewEntry, maxBytes int64, limitCode string) error {
	gz, err := gzip.NewReader(src)
	if err != nil {
		return archiveReadError(err)
	}
	defer gz.Close()
	return s.copyPreviewContent(ctx, w, gz, maxBytes, limitCode)
}

func (s *server) copyPreviewContent(ctx context.Context, w io.Writer, r io.Reader, maxBytes int64, limitCode string) error {
	reader := &limitProgressReader{
		ctx:       ctx,
		r:         r,
		maxBytes:  maxBytes,
		limitCode: limitCode,
	}
	_, err := io.CopyBuffer(contextWriter{ctx: ctx, w: w}, reader, make([]byte, 1024*1024))
	return err
}

func (s *server) extractZip(j *job, dc *davClient, archive io.ReaderAt, size int64) error {
	req := j.Extraction
	zr, err := yzip.NewReader(archive, size)
	if err != nil {
		return archiveReadError(err)
	}

	if len(zr.File) > s.cfg.maxEntries {
		return newError(http.StatusRequestEntityTooLarge, "TOO_MANY_ENTRIES", "Archive contains too many entries")
	}
	includedTotal, err := countIncludedZipEntries(zr.File, req.IncludePaths)
	if err != nil {
		return err
	}
	s.setJob(j, func(j *job) { j.EntriesTotal = includedTotal })
	if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, req.Destination.FolderPath); err != nil {
		return err
	}

	for _, f := range zr.File {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		entryPath, err := safeArchivePath(f.Name)
		if err != nil {
			return newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", f.Name, err))
		}
		if !archivePathIncluded(entryPath, req.IncludePaths) {
			continue
		}
		mode := f.FileInfo().Mode()
		if f.FileInfo().IsDir() {
			if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, joinDavPath(req.Destination.FolderPath, entryPath)); err != nil {
				return err
			}
			s.addEntryDone(j)
			continue
		}
		if mode.Type() != 0 {
			return newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", "ZIP entry is not a regular file")
		}
		if s.cfg.maxEntryBytes > 0 && f.UncompressedSize64 > uint64(s.cfg.maxEntryBytes) {
			return newError(http.StatusRequestEntityTooLarge, "ENTRY_TOO_LARGE", "ZIP entry exceeds configured size limit")
		}
		if f.IsEncrypted() {
			if !zipHasWinZipAES(f.Extra) {
				return newError(http.StatusBadRequest, "UNSUPPORTED_ENCRYPTION", "ZIP standard encryption is disabled")
			}
			if req.Password == "" {
				return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password is required")
			}
			f.SetPassword(req.Password)
			f.DeferAuth = f.CompressedSize64 > s.cfg.aesBufferLimit
		}
		rc, err := f.Open()
		if err != nil {
			return zipReadError(err)
		}
		s.setJob(j, func(j *job) { j.CurrentEntry = entryPath })
		tempPath, resolvedPath, err := s.uploadExtractedEntryStreamToTemp(j, dc, req.Destination, entryPath, rc, int64(f.UncompressedSize64))
		closeErr := rc.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			_ = dc.delete(context.Background(), req.Destination.SpaceID, tempPath)
			return zipReadError(closeErr)
		}
		if err := s.commitExtractedEntryTemp(j, dc, req.Destination.SpaceID, tempPath, resolvedPath); err != nil {
			return err
		}
		s.addEntryDone(j)
	}
	return nil
}

func (s *server) extractTarFromWebDAV(j *job, dc *davClient, gzipped bool) error {
	req := j.Extraction
	body, err := s.archiveStreamFromWebDAV(j, dc, req.Source)
	if err != nil {
		return err
	}
	defer body.Close()

	s.setJob(j, func(j *job) { j.Stage = "extracting" })
	return s.extractTar(j, dc, body, gzipped)
}

func (s *server) extractTar(j *job, dc *davClient, src io.Reader, gzipped bool) error {
	req := j.Extraction
	var r io.Reader = src
	var gz *gzip.Reader
	if gzipped {
		var err error
		gz, err = gzip.NewReader(src)
		if err != nil {
			return archiveReadError(err)
		}
		defer func() {
			if gz != nil {
				_ = gz.Close()
			}
		}()
		r = gz
	}

	if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, req.Destination.FolderPath); err != nil {
		return err
	}
	tr := tar.NewReader(r)
	entries := 0
	for {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return archiveReadError(err)
		}
		entries++
		if entries > s.cfg.maxEntries {
			return newError(http.StatusRequestEntityTooLarge, "TOO_MANY_ENTRIES", "Archive contains too many entries")
		}
		entryPath, err := safeArchivePath(h.Name)
		if err != nil {
			return newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", h.Name, err))
		}
		if !archivePathIncluded(entryPath, req.IncludePaths) {
			continue
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, joinDavPath(req.Destination.FolderPath, entryPath)); err != nil {
				return err
			}
			s.addEntryDone(j)
		case tar.TypeReg, tar.TypeRegA:
			if s.cfg.maxEntryBytes > 0 && h.Size > s.cfg.maxEntryBytes {
				return newError(http.StatusRequestEntityTooLarge, "ENTRY_TOO_LARGE", "tar entry exceeds configured size limit")
			}
			s.setJob(j, func(j *job) {
				j.EntriesTotal = entries
				j.CurrentEntry = entryPath
			})
			if err := s.uploadExtractedEntryKnownSize(j, dc, req.Destination, entryPath, tr, h.Size); err != nil {
				return err
			}
			s.addEntryDone(j)
		default:
			return newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", fmt.Sprintf("Unsupported tar entry type %q", h.Typeflag))
		}
	}
	if gz != nil {
		if _, err := io.Copy(io.Discard, gz); err != nil {
			return archiveReadError(err)
		}
		if err := gz.Close(); err != nil {
			return archiveReadError(err)
		}
		gz = nil
	}
	return nil
}

func (s *server) extractGzipSingleFromWebDAV(j *job, dc *davClient) error {
	req := j.Extraction
	workDir, err := os.MkdirTemp(s.cfg.tmpDir, "job-"+j.ID+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)

	body, err := s.archiveStreamFromWebDAV(j, dc, req.Source)
	if err != nil {
		return err
	}
	defer body.Close()

	s.setJob(j, func(j *job) { j.Stage = "extracting" })
	return s.extractGzipSingle(j, dc, body, workDir)
}

func (s *server) extractGzipSingle(j *job, dc *davClient, src io.Reader, tempDir string) error {
	req := j.Extraction
	gz, err := gzip.NewReader(src)
	if err != nil {
		return archiveReadError(err)
	}
	defer func() {
		if gz != nil {
			_ = gz.Close()
		}
	}()

	name := strings.TrimSuffix(strings.TrimSuffix(req.Source.Name, ".gz"), ".GZ")
	if gz.Name != "" {
		if _, err := safeArchivePath(gz.Name); err == nil {
			name = path.Base(gz.Name)
		}
	}
	if name == "" || name == req.Source.Name {
		name = "archive-output"
	}
	entryPath, err := safeArchivePath(name)
	if err != nil {
		return err
	}
	if !archivePathIncluded(entryPath, req.IncludePaths) {
		return nil
	}
	if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, req.Destination.FolderPath); err != nil {
		return err
	}
	s.setJob(j, func(j *job) {
		j.EntriesTotal = 1
		j.CurrentEntry = entryPath
	})
	if err := s.uploadExtractedEntrySpool(j, dc, req.Destination, entryPath, gz, tempDir); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return archiveReadError(err)
	}
	gz = nil
	s.addEntryDone(j)
	return nil
}

func (s *server) extractSevenZip(j *job, dc *davClient, archive io.ReaderAt, size int64) error {
	req := j.Extraction
	var zr *sevenzip.Reader
	var err error
	if req.Password == "" {
		zr, err = sevenzip.NewReader(archive, size)
	} else {
		zr, err = sevenzip.NewReaderWithPassword(archive, size, req.Password)
	}
	if err != nil {
		if req.Password == "" {
			return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password may be required")
		}
		return archiveReadError(err)
	}

	if len(zr.File) > s.cfg.maxEntries {
		return newError(http.StatusRequestEntityTooLarge, "TOO_MANY_ENTRIES", "Archive contains too many entries")
	}
	includedTotal, err := countIncludedSevenZipEntries(zr.File, req.IncludePaths)
	if err != nil {
		return err
	}
	s.setJob(j, func(j *job) { j.EntriesTotal = includedTotal })
	if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, req.Destination.FolderPath); err != nil {
		return err
	}

	for _, f := range zr.File {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		entryPath, err := safeArchivePath(f.Name)
		if err != nil {
			return newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", f.Name, err))
		}
		if !archivePathIncluded(entryPath, req.IncludePaths) {
			continue
		}
		info := f.FileInfo()
		if info.IsDir() {
			if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, joinDavPath(req.Destination.FolderPath, entryPath)); err != nil {
				return err
			}
			s.addEntryDone(j)
			continue
		}
		if info.Mode().Type() != 0 {
			return newError(http.StatusBadRequest, "UNSUPPORTED_ENTRY", "7z entry is not a regular file")
		}
		if s.cfg.maxEntryBytes > 0 && info.Size() > s.cfg.maxEntryBytes {
			return newError(http.StatusRequestEntityTooLarge, "ENTRY_TOO_LARGE", "7z entry exceeds configured size limit")
		}
		rc, err := f.Open()
		if err != nil {
			if req.Password == "" {
				return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password may be required")
			}
			return archiveReadError(err)
		}
		s.setJob(j, func(j *job) { j.CurrentEntry = entryPath })
		tempPath, resolvedPath, err := s.uploadExtractedEntryStreamToTemp(j, dc, req.Destination, entryPath, rc, info.Size())
		closeErr := rc.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			_ = dc.delete(context.Background(), req.Destination.SpaceID, tempPath)
			return archiveReadError(closeErr)
		}
		if err := s.commitExtractedEntryTemp(j, dc, req.Destination.SpaceID, tempPath, resolvedPath); err != nil {
			return err
		}
		s.addEntryDone(j)
	}
	return nil
}

func (s *server) extractRar(j *job, dc *davClient, archive io.ReaderAt, size int64) error {
	req := j.Extraction
	entries, err := s.scanRarArchive(j.ctx, archive, size, req.Password, req.Password != "")
	if err != nil {
		return err
	}
	if req.Password == "" && rarEntriesContainEncrypted(entries) {
		return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password is required")
	}
	includedTotal := countIncludedRarEntries(entries, req.IncludePaths)
	s.setJob(j, func(j *job) { j.EntriesTotal = includedTotal })
	if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, req.Destination.FolderPath); err != nil {
		return err
	}

	rr, err := s.newRarReader(io.NewSectionReader(archive, 0, size), req.Password)
	if err != nil {
		return err
	}
	var workDir string
	defer func() {
		if workDir != "" {
			_ = os.RemoveAll(workDir)
		}
	}()
	for {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		h, err := rr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return rarReadError(err, req.Password)
		}
		entry, err := rarArchiveEntryFromHeader(h)
		if err != nil {
			return err
		}
		included := archivePathIncluded(entry.Path, req.IncludePaths)
		if !included {
			if entry.Solid && !entry.IsDir {
				if err := discardRarEntry(j.ctx, rr, s.cfg.maxEntryBytes, "ENTRY_TOO_LARGE"); err != nil {
					return rarStreamError(err, req.Password)
				}
			}
			continue
		}
		if entry.IsDir {
			if err := dc.mkcolAll(j.ctx, req.Destination.SpaceID, joinDavPath(req.Destination.FolderPath, entry.Path)); err != nil {
				return err
			}
			s.addEntryDone(j)
			continue
		}
		if req.Password == "" && entry.Encrypted {
			return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password is required")
		}
		if s.cfg.maxEntryBytes > 0 && !entry.UnknownSize && entry.Size > s.cfg.maxEntryBytes {
			return newError(http.StatusRequestEntityTooLarge, "ENTRY_TOO_LARGE", "RAR entry exceeds configured size limit")
		}
		s.setJob(j, func(j *job) { j.CurrentEntry = entry.Path })
		if entry.UnknownSize || entry.Size < 0 {
			if workDir == "" {
				workDir, err = os.MkdirTemp(s.cfg.tmpDir, "job-"+j.ID+"-")
				if err != nil {
					return err
				}
			}
			if err := s.uploadExtractedEntrySpool(j, dc, req.Destination, entry.Path, rr, workDir); err != nil {
				return rarStreamError(err, req.Password)
			}
		} else {
			tempPath, resolvedPath, err := s.uploadExtractedEntryStreamToTemp(j, dc, req.Destination, entry.Path, rr, entry.Size)
			if err != nil {
				return rarStreamError(err, req.Password)
			}
			if err := s.commitExtractedEntryTemp(j, dc, req.Destination.SpaceID, tempPath, resolvedPath); err != nil {
				return err
			}
		}
		s.addEntryDone(j)
	}
	return nil
}

func (s *server) uploadExtractedEntryKnownSize(j *job, dc *davClient, dest destinationRef, entryPath string, r io.Reader, size int64) error {
	tempPath, resolvedPath, err := s.uploadExtractedEntryStreamToTemp(j, dc, dest, entryPath, r, size)
	if err != nil {
		return err
	}
	return s.commitExtractedEntryTemp(j, dc, dest.SpaceID, tempPath, resolvedPath)
}

func (s *server) uploadExtractedEntrySpool(j *job, dc *davClient, dest destinationRef, entryPath string, r io.Reader, tempDir string) error {
	localPath, size, cleanup, err := s.spoolExtractedEntry(j, entryPath, r, tempDir)
	if err != nil {
		return err
	}
	defer cleanup()
	return s.uploadExtractedEntryFile(j, dc, dest, entryPath, localPath, size)
}

func (s *server) uploadExtractedEntryStreamToTemp(j *job, dc *davClient, dest destinationRef, entryPath string, r io.Reader, size int64) (string, string, error) {
	if size < 0 {
		return "", "", newError(http.StatusBadRequest, "ENTRY_SIZE_UNKNOWN", "Extracted entry size is required for streaming upload")
	}
	if s.cfg.maxEntryBytes > 0 && size > s.cfg.maxEntryBytes {
		return "", "", newError(http.StatusRequestEntityTooLarge, "ENTRY_TOO_LARGE", "Archive entry exceeds configured size limit")
	}
	tempPath, resolvedPath, err := s.prepareExtractedEntryTarget(j, dc, dest, entryPath)
	if err != nil {
		return "", "", err
	}
	reader := &limitProgressReader{
		ctx:      j.ctx,
		r:        r,
		maxBytes: s.cfg.maxEntryBytes,
		onBytes: func(n int64) error {
			return s.addOutputBytes(j, n)
		},
		limitCode: "ENTRY_TOO_LARGE",
	}
	if err := dc.put(j.ctx, dest.SpaceID, tempPath, reader, "application/octet-stream", size); err != nil {
		_ = dc.delete(context.Background(), dest.SpaceID, tempPath)
		return "", "", err
	}
	return tempPath, resolvedPath, nil
}

func (s *server) commitExtractedEntryTemp(j *job, dc *davClient, spaceID, tempPath, resolvedPath string) error {
	overwrite := false
	if j.Extraction != nil && j.Extraction.Conflicts == "replace" {
		overwrite = true
	}
	if err := dc.move(j.ctx, spaceID, tempPath, resolvedPath, overwrite); err != nil {
		_ = dc.delete(context.Background(), spaceID, tempPath)
		return err
	}
	return nil
}

func (s *server) prepareExtractedEntryTarget(j *job, dc *davClient, dest destinationRef, entryPath string) (string, string, error) {
	parent := path.Dir(entryPath)
	if parent != "." && parent != "/" {
		if err := dc.mkcolAll(j.ctx, dest.SpaceID, joinDavPath(dest.FolderPath, parent)); err != nil {
			return "", "", err
		}
	}

	finalPath := joinDavPath(dest.FolderPath, entryPath)
	resolvedPath, err := s.resolveConflict(j.ctx, dc, dest.SpaceID, finalPath, j.Extraction.Conflicts)
	if err != nil {
		return "", "", err
	}
	return tempSiblingPath(resolvedPath, j.ID), resolvedPath, nil
}

func (s *server) spoolExtractedEntry(j *job, entryPath string, r io.Reader, tempDir string) (string, int64, func(), error) {
	if tempDir == "" {
		tempDir = s.cfg.tmpDir
	}
	f, err := os.CreateTemp(tempDir, "entry-"+j.ID+"-")
	if err != nil {
		return "", 0, func() {}, err
	}
	localPath := f.Name()
	cleanup := func() { _ = os.Remove(localPath) }

	reader := &limitProgressReader{
		ctx:      j.ctx,
		r:        r,
		maxBytes: s.cfg.maxEntryBytes,
		onBytes: func(n int64) error {
			return s.addOutputBytes(j, n)
		},
		limitCode: "ENTRY_TOO_LARGE",
	}
	_, copyErr := io.CopyBuffer(f, reader, make([]byte, 1024*1024))
	closeErr := f.Close()
	if copyErr != nil {
		cleanup()
		return "", 0, func() {}, copyErr
	}
	if closeErr != nil {
		cleanup()
		return "", 0, func() {}, closeErr
	}
	stat, err := os.Stat(localPath)
	if err != nil {
		cleanup()
		return "", 0, func() {}, err
	}
	return localPath, stat.Size(), cleanup, nil
}

func (s *server) uploadExtractedEntryFile(j *job, dc *davClient, dest destinationRef, entryPath, localPath string, size int64) error {
	tempPath, resolvedPath, err := s.prepareExtractedEntryTarget(j, dc, dest, entryPath)
	if err != nil {
		return err
	}
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := dc.put(j.ctx, dest.SpaceID, tempPath, f, "application/octet-stream", size); err != nil {
		_ = dc.delete(context.Background(), dest.SpaceID, tempPath)
		return err
	}
	return s.commitExtractedEntryTemp(j, dc, dest.SpaceID, tempPath, resolvedPath)
}

func (s *server) compressToSavedFile(j *job) error {
	req := j.Compression
	if req == nil {
		return newError(http.StatusBadRequest, "BAD_JOB", "Missing compression request")
	}
	dc, err := s.newDAVClient(j.Authorization)
	if err != nil {
		return err
	}
	dest := req.Output.Destination
	if err := dc.mkcolAll(j.ctx, dest.SpaceID, dest.FolderPath); err != nil {
		return err
	}

	finalPath := joinDavPath(dest.FolderPath, archiveOutputName(*req))
	finalPath, err = s.resolveConflict(j.ctx, dc, dest.SpaceID, finalPath, req.Conflicts)
	if err != nil {
		return err
	}
	tempPath := tempSiblingPath(finalPath, j.ID)

	workDir, err := os.MkdirTemp(s.cfg.tmpDir, "job-"+j.ID+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)

	archivePath := filepath.Join(workDir, "archive")
	f, err := os.Create(archivePath)
	if err != nil {
		return err
	}
	writer := io.Writer(f)
	if s.cfg.maxOutputBytes > 0 {
		writer = &limitWriter{
			ctx:       j.ctx,
			w:         writer,
			maxBytes:  s.cfg.maxOutputBytes,
			limitCode: "OUTPUT_TOO_LARGE",
		}
	}
	writeErr := s.runCompressionToWriter(j, writer)
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	stat, err := os.Stat(archivePath)
	if err != nil {
		return err
	}

	contentType := archiveContentType(req.Format)
	s.setJob(j, func(j *job) {
		j.Stage = "uploading"
		j.CurrentEntry = ""
	})
	upload, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	uploadErr := dc.put(j.ctx, dest.SpaceID, tempPath, upload, contentType, stat.Size())
	closeUploadErr := upload.Close()
	if uploadErr != nil {
		_ = dc.delete(context.Background(), dest.SpaceID, tempPath)
		return uploadErr
	}
	if closeUploadErr != nil {
		return closeUploadErr
	}
	if err := dc.move(j.ctx, dest.SpaceID, tempPath, finalPath, req.Conflicts == "replace"); err != nil {
		_ = dc.delete(context.Background(), dest.SpaceID, tempPath)
		return err
	}
	s.finishJob(j, outputInfo{Mode: outputSave, ResourcePath: finalPath})
	return nil
}

func (s *server) runCompressionToWriter(j *job, w io.Writer) error {
	req := j.Compression
	if req == nil {
		return newError(http.StatusBadRequest, "BAD_JOB", "Missing compression request")
	}
	dc, err := s.newDAVClient(j.Authorization)
	if err != nil {
		return err
	}
	s.setJob(j, func(j *job) {
		j.Status = statusRunning
		j.Stage = "planning"
		j.StartedAt = time.Now()
	})
	entries, totalBytes, err := s.buildCompressionPlan(j, dc)
	if err != nil {
		return err
	}
	s.setJob(j, func(j *job) {
		j.BytesDone = 0
		j.BytesTotal = totalBytes
		j.EntriesTotal = len(entries)
		j.Stage = "compressing"
	})

	switch req.Format {
	case "zip":
		return s.writeZip(j, dc, entries, w)
	case "tar.gz", "tgz":
		return s.writeTarGzip(j, dc, entries, w)
	default:
		return newError(http.StatusBadRequest, "UNSUPPORTED_FORMAT", "Unsupported compression format")
	}
}

func (s *server) buildCompressionPlan(j *job, dc *davClient) ([]archiveEntry, int64, error) {
	req := j.Compression
	plan := &compressionPlan{}
	for _, src := range req.Sources {
		if src.Name == "" {
			src.Name = path.Base(src.Path)
		}
		baseName, err := safeArchivePath(src.Name)
		if err != nil {
			return nil, 0, newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected source name %q: %v", src.Name, err))
		}
		if err := s.walkCompressionSource(j.ctx, dc, src.SpaceID, src.Path, baseName, plan); err != nil {
			return nil, 0, err
		}
	}
	return plan.entries, plan.total, nil
}

func (s *server) addCompressionPlanEntry(plan *compressionPlan, entry archiveEntry) error {
	if s.cfg.maxEntries >= 0 && len(plan.entries) >= s.cfg.maxEntries {
		return newError(http.StatusRequestEntityTooLarge, "TOO_MANY_ENTRIES", "Selection contains too many entries")
	}
	plan.entries = append(plan.entries, entry)
	if !entry.IsDir {
		plan.total += entry.Size
	}
	return nil
}

func (s *server) walkCompressionSource(ctx context.Context, dc *davClient, spaceID, resourcePath, entryName string, plan *compressionPlan) error {
	info, err := dc.stat(ctx, spaceID, resourcePath)
	if err != nil {
		return err
	}
	if !info.IsDir {
		return s.addCompressionPlanEntry(plan, archiveEntry{
			SpaceID: spaceID,
			Path:    resourcePath,
			Name:    entryName,
			Size:    info.Size,
			ModTime: info.ModTime,
		})
	}

	if err := s.addCompressionPlanEntry(plan, archiveEntry{
		SpaceID: spaceID,
		Path:    resourcePath,
		Name:    ensureTrailingSlash(entryName),
		IsDir:   true,
		ModTime: info.ModTime,
	}); err != nil {
		return err
	}
	children, err := dc.list(ctx, spaceID, resourcePath)
	if err != nil {
		return err
	}
	for _, child := range children {
		if child.Path == resourcePath || child.Name == ".oc-nodes" {
			continue
		}
		childName, err := safeArchivePath(child.Name)
		if err != nil {
			return newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected source name %q: %v", child.Name, err))
		}
		childEntryName := path.Join(strings.TrimSuffix(entryName, "/"), childName)
		if err := s.walkCompressionSource(ctx, dc, spaceID, child.Path, childEntryName, plan); err != nil {
			return err
		}
	}
	return nil
}

func (s *server) writeZip(j *job, dc *davClient, entries []archiveEntry, w io.Writer) error {
	req := j.Compression
	zw := yzip.NewWriter(contextWriter{ctx: j.ctx, w: w})
	for _, entry := range entries {
		if err := j.ctx.Err(); err != nil {
			_ = zw.Close()
			return err
		}
		s.setJob(j, func(j *job) { j.CurrentEntry = entry.Name })
		h := &yzip.FileHeader{Name: entry.Name, Method: yzip.Deflate}
		if !entry.ModTime.IsZero() {
			h.SetModTime(entry.ModTime)
		}
		if entry.IsDir {
			h.Name = ensureTrailingSlash(h.Name)
			h.SetMode(os.ModeDir | 0o755)
			if _, err := zw.CreateHeader(h); err != nil {
				return err
			}
			s.addEntryDone(j)
			continue
		}
		h.SetMode(0o644)
		if req.Encryption != nil && req.Encryption.Password != "" {
			h.SetPassword(req.Encryption.Password)
			h.SetEncryptionMethod(yzip.AES256Encryption)
		}
		dst, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		if err := s.copySourceToArchive(j, dc, entry, dst); err != nil {
			return err
		}
		s.addEntryDone(j)
	}
	return zw.Close()
}

func (s *server) writeTarGzip(j *job, dc *davClient, entries []archiveEntry, w io.Writer) error {
	gz := gzip.NewWriter(contextWriter{ctx: j.ctx, w: w})
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		if err := j.ctx.Err(); err != nil {
			_ = tw.Close()
			_ = gz.Close()
			return err
		}
		s.setJob(j, func(j *job) { j.CurrentEntry = entry.Name })
		header := &tar.Header{
			Name:    entry.Name,
			ModTime: entry.ModTime,
		}
		if entry.IsDir {
			header.Name = ensureTrailingSlash(header.Name)
			header.Typeflag = tar.TypeDir
			header.Mode = 0o755
			if err := tw.WriteHeader(header); err != nil {
				return err
			}
			s.addEntryDone(j)
			continue
		}
		header.Typeflag = tar.TypeReg
		header.Mode = 0o644
		header.Size = entry.Size
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if err := s.copySourceToArchive(j, dc, entry, tw); err != nil {
			return err
		}
		s.addEntryDone(j)
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

func (s *server) copySourceToArchive(j *job, dc *davClient, entry archiveEntry, dst io.Writer) error {
	body, _, err := dc.get(j.ctx, entry.SpaceID, entry.Path)
	if err != nil {
		return err
	}
	defer body.Close()
	reader := &limitProgressReader{
		ctx:      j.ctx,
		r:        body,
		maxBytes: s.cfg.maxEntryBytes,
		onBytes: func(n int64) error {
			s.addBytesDone(j, n)
			return nil
		},
		limitCode: "ENTRY_TOO_LARGE",
	}
	_, err = io.CopyBuffer(dst, reader, make([]byte, 1024*1024))
	return err
}

func (s *server) newDAVClient(auth string) (*davClient, error) {
	base, err := url.Parse(s.cfg.opencloudURL)
	if err != nil {
		return nil, err
	}
	return &davClient{base: base, httpClient: s.httpClient, auth: auth, requestTimeout: s.cfg.davRequestTimeout}, nil
}

func (c *davClient) url(spaceID, p string) string {
	suffix, rawSuffix := davURLSuffix(spaceID, p)
	u := *c.base
	baseRawPath := strings.TrimRight(u.EscapedPath(), "/")
	u.Path = strings.TrimRight(u.Path, "/") + suffix
	u.RawPath = baseRawPath + rawSuffix
	u.RawQuery = ""
	return u.String()
}

func davURLSuffix(spaceID, p string) (string, string) {
	suffix := "/dav/spaces/" + spaceID
	rawSuffix := "/dav/spaces/" + url.PathEscape(spaceID)
	p = cleanDavPath(p)
	if p != "/" {
		suffix += "/" + strings.TrimPrefix(p, "/")
		rawSuffix += "/" + encodePathSegments(p)
	}
	return suffix, rawSuffix
}

func (c *davClient) do(ctx context.Context, method, spaceID, p string, body io.Reader, headers map[string]string) (*http.Response, error) {
	ctx, cancel := c.withRequestTimeout(ctx)
	req, err := http.NewRequestWithContext(ctx, method, c.url(spaceID, p), body)
	if err != nil {
		if cancel != nil {
			cancel()
		}
		return nil, err
	}
	req.Header.Set("Authorization", c.auth)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		if cancel != nil {
			cancel()
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	if cancel != nil {
		resp.Body = cancelReadCloser{ReadCloser: resp.Body, cancel: cancel}
	}
	return resp, nil
}

func (c *davClient) get(ctx context.Context, spaceID, p string) (io.ReadCloser, int64, error) {
	resp, err := c.do(ctx, http.MethodGet, spaceID, p, nil, nil)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, 0, davStatusError(resp, "DOWNLOAD_FAILED")
	}
	return resp.Body, resp.ContentLength, nil
}

func (c *davClient) readerAt(ctx context.Context, spaceID, p string, size, blockSize int64, onBytes func(int64)) io.ReaderAt {
	if blockSize < 4096 {
		blockSize = 1024 * 1024
	}
	return &davRangeReaderAt{
		ctx:       ctx,
		dc:        c,
		spaceID:   spaceID,
		path:      p,
		size:      size,
		blockSize: blockSize,
		onBytes:   onBytes,
	}
}

func (c *davClient) getRange(ctx context.Context, spaceID, p string, off, length int64) ([]byte, error) {
	if off < 0 {
		return nil, errors.New("negative range offset")
	}
	if length <= 0 {
		return nil, nil
	}
	end := off + length - 1
	if end < off {
		return nil, errors.New("range overflow")
	}
	resp, err := c.do(ctx, http.MethodGet, spaceID, p, nil, map[string]string{
		"Range": fmt.Sprintf("bytes=%d-%d", off, end),
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil, newError(http.StatusBadGateway, "RANGE_UNSUPPORTED", "OpenCloud WebDAV did not honor range request")
	}
	if resp.StatusCode != http.StatusPartialContent {
		return nil, davStatusError(resp, "DOWNLOAD_FAILED")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, length+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > length {
		return nil, newError(http.StatusBadGateway, "RANGE_INVALID", "OpenCloud WebDAV returned too many range bytes")
	}
	return data, nil
}

func (c *davClient) put(ctx context.Context, spaceID, p string, body io.Reader, contentType string, contentLength int64) error {
	ctx, cancel := c.withRequestTimeout(ctx)
	if cancel != nil {
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.url(spaceID, p), contextReader{ctx: ctx, r: body})
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", c.auth)
	req.Header.Set("Content-Type", contentType)
	if contentLength >= 0 {
		req.ContentLength = contentLength
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return davStatusError(resp, "UPLOAD_FAILED")
	}
	return nil
}

func (c *davClient) withRequestTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if c.requestTimeout <= 0 {
		return ctx, nil
	}
	return context.WithTimeout(ctx, c.requestTimeout)
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (r cancelReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.cancel()
	return err
}

func (c *davClient) delete(ctx context.Context, spaceID, p string) error {
	resp, err := c.do(ctx, http.MethodDelete, spaceID, p, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return davStatusError(resp, "DELETE_FAILED")
	}
	return nil
}

func (c *davClient) move(ctx context.Context, spaceID, src, dst string, overwrite bool) error {
	resp, err := c.do(ctx, "MOVE", spaceID, src, nil, map[string]string{
		"Destination": c.url(spaceID, dst),
		"Overwrite":   map[bool]string{true: "T", false: "F"}[overwrite],
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		return davStatusError(resp, "MOVE_FAILED")
	}
	return nil
}

func (c *davClient) mkcolAll(ctx context.Context, spaceID, p string) error {
	p = cleanDavPath(p)
	if p == "/" {
		return nil
	}
	segments := strings.Split(strings.Trim(p, "/"), "/")
	current := ""
	for _, segment := range segments {
		current += "/" + segment
		resp, err := c.do(ctx, "MKCOL", spaceID, current, nil, nil)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusCreated || resp.StatusCode == http.StatusMethodNotAllowed {
			_ = resp.Body.Close()
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			_ = resp.Body.Close()
			continue
		}
		defer resp.Body.Close()
		return davStatusError(resp, "MKCOL_FAILED")
	}
	return nil
}

func (c *davClient) stat(ctx context.Context, spaceID, p string) (davResource, error) {
	resources, err := c.propfind(ctx, spaceID, p, "0")
	if err != nil {
		return davResource{}, err
	}
	for _, res := range resources {
		if cleanDavPath(res.Path) == cleanDavPath(p) {
			return res, nil
		}
	}
	if len(resources) > 0 {
		return resources[0], nil
	}
	return davResource{}, newError(http.StatusNotFound, "NOT_FOUND", "Resource not found")
}

func (c *davClient) exists(ctx context.Context, spaceID, p string) (bool, error) {
	_, err := c.stat(ctx, spaceID, p)
	if err == nil {
		return true, nil
	}
	var appErr *appError
	if errors.As(err, &appErr) && appErr.Status == http.StatusNotFound {
		return false, nil
	}
	return false, err
}

func (c *davClient) list(ctx context.Context, spaceID, p string) ([]davResource, error) {
	resources, err := c.propfind(ctx, spaceID, p, "1")
	if err != nil {
		return nil, err
	}
	p = cleanDavPath(p)
	out := make([]davResource, 0, len(resources))
	for _, res := range resources {
		if cleanDavPath(res.Path) == p {
			continue
		}
		out = append(out, res)
	}
	return out, nil
}

func (c *davClient) propfind(ctx context.Context, spaceID, p, depth string) ([]davResource, error) {
	body := strings.NewReader(`<?xml version="1.0" encoding="utf-8" ?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`)
	resp, err := c.do(ctx, "PROPFIND", spaceID, p, body, map[string]string{
		"Depth":        depth,
		"Content-Type": "application/xml; charset=utf-8",
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, newError(http.StatusNotFound, "NOT_FOUND", "Resource not found")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, davStatusError(resp, "PROPFIND_FAILED")
	}
	var ms multistatusXML
	if err := xml.NewDecoder(resp.Body).Decode(&ms); err != nil {
		return nil, err
	}
	resources := make([]davResource, 0, len(ms.Responses))
	for _, response := range ms.Responses {
		prop := firstOKProp(response)
		resPath := c.hrefToPath(spaceID, response.Href)
		name := prop.DisplayName
		if name == "" {
			name = path.Base(strings.TrimSuffix(resPath, "/"))
		}
		size, _ := strconv.ParseInt(strings.TrimSpace(prop.GetContentLength), 10, 64)
		modTime, _ := http.ParseTime(prop.GetLastModified)
		resources = append(resources, davResource{
			SpaceID: spaceID,
			Path:    resPath,
			Name:    name,
			IsDir:   prop.ResourceType.Collection != nil,
			Size:    size,
			ModTime: modTime,
		})
	}
	return resources, nil
}

func (c *davClient) hrefToPath(spaceID, href string) string {
	value := href
	if u, err := url.Parse(href); err == nil && u.Path != "" {
		value = u.Path
	}
	prefix := "/dav/spaces/" + url.PathEscape(spaceID)
	if strings.HasPrefix(value, prefix) {
		value = strings.TrimPrefix(value, prefix)
	}
	if value == "" {
		return "/"
	}
	decoded, err := url.PathUnescape(value)
	if err != nil {
		decoded = value
	}
	return cleanDavPath(decoded)
}

func firstOKProp(response responseXML) propXML {
	for _, ps := range response.Propstat {
		if strings.Contains(ps.Status, " 200 ") || strings.HasSuffix(ps.Status, " 200 OK") {
			return ps.Prop
		}
	}
	if len(response.Propstat) > 0 {
		return response.Propstat[0].Prop
	}
	return propXML{}
}

func davStatusError(resp *http.Response, code string) error {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	message := strings.TrimSpace(string(data))
	if message == "" {
		message = resp.Status
	}
	status := resp.StatusCode
	switch status {
	case http.StatusUnauthorized:
		code = "UNAUTHORIZED"
	case http.StatusForbidden:
		code = "PERMISSION_DENIED"
	case http.StatusNotFound:
		code = "NOT_FOUND"
	case http.StatusInsufficientStorage:
		code = "QUOTA_EXCEEDED"
	}
	return newError(status, code, message)
}

func (s *server) resolveConflict(ctx context.Context, dc *davClient, spaceID, desiredPath, policy string) (string, error) {
	if policy == "" {
		policy = "keep-both"
	}
	exists, err := dc.exists(ctx, spaceID, desiredPath)
	if err != nil {
		return "", err
	}
	if !exists || policy == "replace" {
		return desiredPath, nil
	}
	if policy == "fail" {
		return "", newError(http.StatusConflict, "CONFLICT", "Destination already exists")
	}

	dir := path.Dir(desiredPath)
	base := path.Base(desiredPath)
	ext := path.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 1; i < 10000; i++ {
		candidate := joinDavPath(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		exists, err := dc.exists(ctx, spaceID, candidate)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", newError(http.StatusConflict, "CONFLICT", "Could not resolve destination conflict")
}

func validateExtractionRequest(req *extractionRequest) error {
	if err := validateSpaceID(req.Source.SpaceID, "source.spaceId"); err != nil {
		return err
	}
	if err := validateSpaceID(req.Destination.SpaceID, "destination.spaceId"); err != nil {
		return err
	}
	if req.Source.Name == "" {
		req.Source.Name = path.Base(req.Source.Path)
	}
	if req.Destination.FolderPath == "" {
		req.Destination.FolderPath = req.Destination.Path
	}
	if req.Destination.FolderPath == "" {
		return newError(http.StatusBadRequest, "BAD_REQUEST", "destination.folderPath is required")
	}
	if err := validateDavPath(req.Source.Path, "source.path"); err != nil {
		return err
	}
	if err := validateDavPath(req.Destination.FolderPath, "destination.folderPath"); err != nil {
		return err
	}
	includePaths, err := normalizeArchiveIncludePaths(req.IncludePaths)
	if err != nil {
		return err
	}
	req.IncludePaths = includePaths
	req.Conflicts = normalizeConflictPolicy(req.Conflicts)
	if detectArchiveKind(req.Source.Name, req.Source.MimeType) == "" {
		return newError(http.StatusBadRequest, "UNSUPPORTED_ARCHIVE", "Unsupported archive type")
	}
	return nil
}

func validatePreviewRequest(req *previewRequest) error {
	if err := validateSpaceID(req.Source.SpaceID, "source.spaceId"); err != nil {
		return err
	}
	if req.Source.Name == "" {
		req.Source.Name = path.Base(req.Source.Path)
	}
	if err := validateDavPath(req.Source.Path, "source.path"); err != nil {
		return err
	}
	if detectArchiveKind(req.Source.Name, req.Source.MimeType) == "" {
		return newError(http.StatusBadRequest, "UNSUPPORTED_ARCHIVE", "Unsupported archive type")
	}
	return nil
}

func validateCompressionRequest(req *compressionRequest) error {
	if req.Format == "" {
		req.Format = "zip"
	}
	if req.Format == "tgz" {
		req.Format = "tar.gz"
	}
	if req.Format != "zip" && req.Format != "tar.gz" {
		return newError(http.StatusBadRequest, "UNSUPPORTED_FORMAT", "Unsupported compression format")
	}
	if len(req.Sources) == 0 {
		return newError(http.StatusBadRequest, "BAD_REQUEST", "sources are required")
	}
	for i := range req.Sources {
		if err := validateSpaceID(req.Sources[i].SpaceID, "source.spaceId"); err != nil {
			return err
		}
		if err := validateDavPath(req.Sources[i].Path, "source.path"); err != nil {
			return err
		}
		if req.Sources[i].Name == "" {
			req.Sources[i].Name = path.Base(req.Sources[i].Path)
		}
	}
	if req.Encryption != nil {
		if req.Format != "zip" {
			return newError(http.StatusBadRequest, "UNSUPPORTED_ENCRYPTION", "Only ZIP supports encryption")
		}
		if req.Encryption.Method == "" {
			req.Encryption.Method = "zip-aes256"
		}
		if req.Encryption.Method != "zip-aes256" {
			return newError(http.StatusBadRequest, "UNSUPPORTED_ENCRYPTION", "Only ZIP AES-256 encryption is supported")
		}
		if req.Encryption.Password == "" {
			return newError(http.StatusBadRequest, "PASSWORD_REQUIRED", "Encryption password is required")
		}
	}
	if req.Output.Mode == "" {
		req.Output.Mode = outputSave
	}
	if req.Output.Mode != outputSave && req.Output.Mode != outputDownload {
		return newError(http.StatusBadRequest, "BAD_REQUEST", "output.mode must be save or download")
	}
	if req.Output.Mode == outputSave {
		if err := validateSpaceID(req.Output.Destination.SpaceID, "output.destination.spaceId"); err != nil {
			return err
		}
		if req.Output.Destination.FolderPath == "" {
			req.Output.Destination.FolderPath = req.Output.Destination.Path
		}
		if err := validateDavPath(req.Output.Destination.FolderPath, "output.destination.folderPath"); err != nil {
			return err
		}
	}
	req.Conflicts = normalizeConflictPolicy(req.Conflicts)
	return nil
}

func validateSpaceID(id, label string) error {
	if id == "" {
		return newError(http.StatusBadRequest, "BAD_REQUEST", label+" is required")
	}
	if len(id) > 512 {
		return newError(http.StatusBadRequest, "BAD_REQUEST", label+" is too long")
	}
	if id == "." || id == ".." || strings.Contains(id, "..") {
		return newError(http.StatusBadRequest, "BAD_REQUEST", label+" must not contain ..")
	}
	if strings.ContainsAny(id, `/\`) {
		return newError(http.StatusBadRequest, "BAD_REQUEST", label+" must not contain path separators")
	}
	for _, r := range id {
		if r == 0 || unicode.IsControl(r) {
			return newError(http.StatusBadRequest, "BAD_REQUEST", label+" contains control characters")
		}
	}
	return nil
}

func validateDavPath(p, label string) error {
	if !strings.HasPrefix(p, "/") {
		return newError(http.StatusBadRequest, "BAD_REQUEST", label+" must be absolute")
	}
	if strings.ContainsRune(p, 0) {
		return newError(http.StatusBadRequest, "BAD_REQUEST", label+" contains NUL")
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return newError(http.StatusBadRequest, "BAD_REQUEST", label+" must not contain ..")
		}
	}
	return nil
}

func normalizeConflictPolicy(policy string) string {
	switch policy {
	case "", "keep-both", "replace", "fail":
		if policy == "" {
			return "keep-both"
		}
		return policy
	default:
		return "keep-both"
	}
}

func readJSON(r *http.Request, maxBytes int64, out any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxBytes+1))
	if err := decoder.Decode(out); err != nil {
		return newError(http.StatusBadRequest, "BAD_JSON", "Request body must be valid JSON")
	}
	return nil
}

func getAuthHeader(r *http.Request) (string, error) {
	if value := r.Header.Get("Authorization"); value != "" {
		return value, nil
	}
	if value := r.Header.Get("X-Access-Token"); value != "" {
		if strings.HasPrefix(strings.ToLower(value), "bearer ") {
			return value, nil
		}
		return "Bearer " + value, nil
	}
	return "", newError(http.StatusUnauthorized, "UNAUTHORIZED", "Missing Authorization header")
}

func (s *server) addJob(j *job) {
	s.mu.Lock()
	s.jobs[j.ID] = j
	s.mu.Unlock()
	s.publish(j)
}

func (s *server) addPreview(p *previewSession) {
	s.mu.Lock()
	s.previews[p.ID] = p
	s.mu.Unlock()
}

func (s *server) getAuthorizedPreview(r *http.Request, encodedID string) (*previewSession, error) {
	auth, err := getAuthHeader(r)
	if err != nil {
		return nil, err
	}
	id, _ := url.PathUnescape(encodedID)
	s.mu.RLock()
	p := s.previews[id]
	s.mu.RUnlock()
	if p == nil {
		return nil, newError(http.StatusNotFound, "NOT_FOUND", "Archive preview not found")
	}
	if p.AuthHash != hashAuth(auth) {
		return nil, newError(http.StatusForbidden, "FORBIDDEN", "Preview belongs to a different session")
	}
	p.mu.Lock()
	p.UpdatedAt = time.Now()
	p.mu.Unlock()
	return p, nil
}

func (s *server) getPreviewForEntryContent(r *http.Request, encodedPreviewID, encodedEntryID string) (*previewSession, error) {
	if token := r.URL.Query().Get("token"); token != "" {
		id, _ := url.PathUnescape(encodedPreviewID)
		entryID, _ := url.PathUnescape(encodedEntryID)
		s.mu.RLock()
		p := s.previews[id]
		s.mu.RUnlock()
		if p == nil {
			return nil, newError(http.StatusNotFound, "NOT_FOUND", "Archive preview not found")
		}
		if !p.consumeDownloadToken(token, entryID, time.Now()) {
			return nil, newError(http.StatusForbidden, "FORBIDDEN", "Invalid download token")
		}
		p.mu.Lock()
		p.UpdatedAt = time.Now()
		p.mu.Unlock()
		return p, nil
	}
	return s.getAuthorizedPreview(r, encodedPreviewID)
}

func (s *server) publicPreview(p *previewSession, entries []previewEntry) publicPreview {
	p.mu.Lock()
	defer p.mu.Unlock()
	return publicPreview{
		ID:           p.ID,
		Format:       p.Format,
		Source:       p.Source,
		Entries:      entries,
		TotalEntries: len(p.Entries),
		CreatedAt:    p.CreatedAt,
		UpdatedAt:    p.UpdatedAt,
		ExpiresAt:    p.UpdatedAt.Add(s.cfg.jobTTL),
	}
}

func (p *previewSession) entryByID(id string) (previewEntry, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.EntryByID[id]
	return entry, ok
}

func (p *previewSession) addDownloadToken(token, entryID string, expiresAt time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.DownloadToken[token] = downloadToken{EntryID: entryID, ExpiresAt: expiresAt}
	p.UpdatedAt = time.Now()
}

func (p *previewSession) consumeDownloadToken(token, entryID string, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	expected, ok := p.DownloadToken[token]
	if ok {
		delete(p.DownloadToken, token)
	}
	if !ok || expected.EntryID == "" || now.After(expected.ExpiresAt) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected.EntryID), []byte(entryID)) == 1
}

func (p *previewSession) entriesByParent(parent string) []previewEntry {
	p.mu.Lock()
	defer p.mu.Unlock()
	entries := make([]previewEntry, 0)
	for _, entry := range p.Entries {
		if entry.Parent == parent {
			entries = append(entries, entry)
		}
	}
	return entries
}

func (s *server) getAuthorizedJob(r *http.Request, encodedID string) (*job, error) {
	auth, err := getAuthHeader(r)
	if err != nil {
		return nil, err
	}
	id, _ := url.PathUnescape(encodedID)
	s.mu.RLock()
	j := s.jobs[id]
	s.mu.RUnlock()
	if j == nil {
		return nil, newError(http.StatusNotFound, "NOT_FOUND", "Job not found")
	}
	if j.AuthHash != hashAuth(auth) {
		return nil, newError(http.StatusForbidden, "FORBIDDEN", "Job belongs to a different session")
	}
	return j, nil
}

func (s *server) getDownloadJob(r *http.Request, encodedID string) (*job, error) {
	token := r.URL.Query().Get("token")
	if token == "" {
		return s.getAuthorizedJob(r, encodedID)
	}
	id, _ := url.PathUnescape(encodedID)
	s.mu.RLock()
	j := s.jobs[id]
	s.mu.RUnlock()
	if j == nil {
		return nil, newError(http.StatusNotFound, "NOT_FOUND", "Job not found")
	}
	j.mu.Lock()
	expected := j.DownloadToken
	expiresAt := j.TokenExpiresAt
	j.mu.Unlock()
	if expected == "" || time.Now().After(expiresAt) || subtle.ConstantTimeCompare([]byte(token), []byte(expected)) != 1 {
		return nil, newError(http.StatusForbidden, "FORBIDDEN", "Invalid download token")
	}
	return j, nil
}

func (s *server) setJob(j *job, update func(*job)) {
	j.mu.Lock()
	update(j)
	j.UpdatedAt = time.Now()
	j.mu.Unlock()
	s.publish(j)
}

func (s *server) publicJob(j *job) publicJob {
	j.mu.Lock()
	defer j.mu.Unlock()
	progress := progressInfo{
		BytesDone:    j.BytesDone,
		BytesTotal:   j.BytesTotal,
		EntriesDone:  j.EntriesDone,
		EntriesTotal: j.EntriesTotal,
		CurrentEntry: j.CurrentEntry,
	}
	if j.BytesTotal > 0 {
		progress.Percent = int(minInt64(100, j.BytesDone*100/j.BytesTotal))
	}
	if !j.StartedAt.IsZero() {
		elapsed := time.Since(j.StartedAt).Seconds()
		if elapsed > 0 {
			progress.SpeedBytesPerSecond = int64(float64(j.BytesDone) / elapsed)
		}
	}
	return publicJob{
		ID:         j.ID,
		Type:       j.Type,
		Status:     j.Status,
		Stage:      j.Stage,
		Format:     j.Format,
		Code:       j.Code,
		Error:      j.Error,
		Progress:   progress,
		Output:     j.Output,
		CreatedAt:  j.CreatedAt,
		UpdatedAt:  j.UpdatedAt,
		FinishedAt: j.FinishedAt,
	}
}

func (s *server) addBytesDone(j *job, n int64) {
	s.setJob(j, func(j *job) { j.BytesDone += n })
}

func (s *server) addOutputBytes(j *job, n int64) error {
	var exceeded bool
	s.setJob(j, func(j *job) {
		j.OutputBytes += n
		j.BytesDone += n
		if s.cfg.maxOutputBytes > 0 && j.OutputBytes > s.cfg.maxOutputBytes {
			j.Code = "OUTPUT_TOO_LARGE"
			exceeded = true
		}
	})
	if exceeded {
		return newError(http.StatusRequestEntityTooLarge, "OUTPUT_TOO_LARGE", "Extracted output exceeds configured size limit")
	}
	return nil
}

func (s *server) addEntryDone(j *job) {
	s.setJob(j, func(j *job) { j.EntriesDone++ })
}

func (s *server) finishJob(j *job, output outputInfo) {
	s.setJob(j, func(j *job) {
		j.Status = statusSucceeded
		j.Stage = "done"
		j.CurrentEntry = ""
		if output.Mode != "" {
			j.Output = output
		}
		now := time.Now()
		j.FinishedAt = &now
		j.clearSecretsLocked()
	})
}

func (s *server) failJob(j *job, err error) {
	var appErr *appError
	code := "INTERNAL"
	message := err.Error()
	if errors.As(err, &appErr) {
		code = appErr.Code
		message = appErr.Message
	}
	s.setJob(j, func(j *job) {
		if j.Status == statusCancelled {
			return
		}
		j.Status = statusFailed
		j.Stage = "failed"
		j.Code = code
		j.Error = message
		now := time.Now()
		j.FinishedAt = &now
		j.clearSecretsLocked()
	})
}

func (s *server) cancelJob(j *job) {
	s.setJob(j, func(j *job) {
		j.Status = statusCancelled
		j.Stage = "cancelled"
		j.Code = "CANCELLED"
		now := time.Now()
		j.FinishedAt = &now
		j.clearSecretsLocked()
	})
}

func (s *server) markDownloadStarting(j *job) bool {
	ok := false
	s.setJob(j, func(j *job) {
		if j.Status == statusQueued {
			j.Status = statusRunning
			j.Stage = "waiting"
			j.DownloadToken = ""
			j.TokenExpiresAt = time.Time{}
			ok = true
		}
	})
	return ok
}

func (j *job) clearSecretsLocked() {
	j.Authorization = ""
	j.DownloadToken = ""
	j.TokenExpiresAt = time.Time{}
	if j.Extraction != nil {
		j.Extraction.Password = ""
	}
	if j.Compression != nil && j.Compression.Encryption != nil {
		j.Compression.Encryption.Password = ""
	}
}

func (s *server) addSubscriber(sub subscriber) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextSubID++
	s.subscribers[s.nextSubID] = sub
	return s.nextSubID
}

func (s *server) removeSubscriber(id int) {
	s.mu.Lock()
	delete(s.subscribers, id)
	s.mu.Unlock()
}

func (s *server) publish(j *job) {
	payload, err := json.Marshal(s.publicJob(j))
	if err != nil {
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, sub := range s.subscribers {
		if sub.authHash != j.AuthHash {
			continue
		}
		select {
		case sub.ch <- payload:
		default:
		}
	}
}

func (s *server) sweepLoop() {
	ticker := time.NewTicker(minDuration(s.cfg.jobTTL, 10*time.Minute))
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-s.cfg.jobTTL)
		s.mu.Lock()
		for id, j := range s.jobs {
			j.mu.Lock()
			remove := j.UpdatedAt.Before(cutoff) && (j.Status == statusSucceeded || j.Status == statusFailed || j.Status == statusCancelled)
			j.mu.Unlock()
			if remove {
				delete(s.jobs, id)
			}
		}
		for id, p := range s.previews {
			p.mu.Lock()
			remove := p.UpdatedAt.Before(cutoff)
			p.mu.Unlock()
			if remove {
				delete(s.previews, id)
			}
		}
		s.mu.Unlock()
	}
}

type davRangeReaderAt struct {
	ctx       context.Context
	dc        *davClient
	spaceID   string
	path      string
	size      int64
	blockSize int64
	onBytes   func(int64)

	mu         sync.Mutex
	cacheStart int64
	cache      []byte
}

func (r *davRangeReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if off < 0 {
		return 0, errors.New("negative offset")
	}
	if off >= r.size {
		return 0, io.EOF
	}
	readable := minInt64(int64(len(p)), r.size-off)
	total := 0
	for int64(total) < readable {
		chunkLen := int(minInt64(readable-int64(total), r.blockSize))
		n, err := r.readAtChunk(p[total:total+chunkLen], off+int64(total))
		total += n
		if err != nil {
			if total > 0 {
				return total, err
			}
			return 0, err
		}
		if n == 0 {
			break
		}
	}
	if total < len(p) {
		return total, io.EOF
	}
	return total, nil
}

func (r *davRangeReaderAt) readAtChunk(p []byte, off int64) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	r.mu.Lock()
	if r.cacheContainsLocked(off, int64(len(p))) {
		cacheStart := r.cacheStart
		cache := r.cache
		n := copy(p, cache[int(off-cacheStart):])
		r.mu.Unlock()
		if n < len(p) {
			return n, io.EOF
		}
		return n, nil
	}
	r.mu.Unlock()

	length := minInt64(r.blockSize, r.size-off)
	if length < int64(len(p)) {
		length = int64(len(p))
	}
	data, err := r.dc.getRange(r.ctx, r.spaceID, r.path, off, length)
	if err != nil {
		return 0, err
	}
	if len(data) == 0 {
		return 0, io.EOF
	}
	if r.onBytes != nil {
		r.onBytes(int64(len(data)))
	}
	r.mu.Lock()
	r.cacheStart = off
	r.cache = data
	r.mu.Unlock()

	n := copy(p, data)
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (r *davRangeReaderAt) cacheContainsLocked(off, length int64) bool {
	if r.cache == nil {
		return false
	}
	cacheEnd := r.cacheStart + int64(len(r.cache))
	return off >= r.cacheStart && off+length <= cacheEnd
}

type readCloser struct {
	io.Reader
	io.Closer
}

type previewContentFile struct {
	Path string
	Size int64
}

func (f *previewContentFile) cleanup() {
	if f != nil && f.Path != "" {
		_ = os.Remove(f.Path)
	}
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.r.Read(p)
	}
}

type contextWriter struct {
	ctx context.Context
	w   io.Writer
}

func (w contextWriter) Write(p []byte) (int, error) {
	select {
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	default:
		return w.w.Write(p)
	}
}

type limitWriter struct {
	ctx       context.Context
	w         io.Writer
	maxBytes  int64
	written   int64
	limitCode string
}

func (w *limitWriter) Write(p []byte) (int, error) {
	select {
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	default:
	}
	if w.maxBytes > 0 && w.written+int64(len(p)) > w.maxBytes {
		allowed := w.maxBytes - w.written
		if allowed > 0 {
			n, err := w.w.Write(p[:allowed])
			w.written += int64(n)
			if err != nil {
				return n, err
			}
			return n, newError(http.StatusRequestEntityTooLarge, w.limitCode, "Configured byte limit exceeded")
		}
		return 0, newError(http.StatusRequestEntityTooLarge, w.limitCode, "Configured byte limit exceeded")
	}
	n, err := w.w.Write(p)
	w.written += int64(n)
	return n, err
}

type limitProgressReader struct {
	ctx       context.Context
	r         io.Reader
	maxBytes  int64
	readBytes int64
	onBytes   func(int64) error
	limitCode string
}

func (r *limitProgressReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
	}
	n, err := r.r.Read(p)
	if n > 0 {
		r.readBytes += int64(n)
		if r.onBytes != nil {
			if err := r.onBytes(int64(n)); err != nil {
				return n, err
			}
		}
		if r.maxBytes > 0 && r.readBytes > r.maxBytes {
			return n, newError(http.StatusRequestEntityTooLarge, r.limitCode, "Configured byte limit exceeded")
		}
	}
	return n, err
}

var windowsDrive = regexp.MustCompile(`^[A-Za-z]:($|[\\/])`)

func splitPreviewContentPath(pathname string) (string, string) {
	value := strings.TrimPrefix(pathname, "/api/previews/")
	parts := strings.SplitN(value, "/entries/", 2)
	if len(parts) != 2 {
		return "", ""
	}
	entryID := strings.TrimSuffix(parts[1], "/content")
	return parts[0], entryID
}

func splitPreviewDownloadPath(pathname string) (string, string) {
	value := strings.TrimPrefix(pathname, "/api/previews/")
	parts := strings.SplitN(value, "/entries/", 2)
	if len(parts) != 2 {
		return "", ""
	}
	entryID := strings.TrimSuffix(parts[1], "/download")
	return parts[0], entryID
}

func normalizeArchiveIncludePaths(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(strings.Trim(value, "/"))
		if value == "" {
			continue
		}
		cleaned, err := safeArchivePath(value)
		if err != nil {
			return nil, newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected include path %q: %v", value, err))
		}
		if seen[cleaned] {
			continue
		}
		seen[cleaned] = true
		out = append(out, cleaned)
	}
	sort.Strings(out)
	return out, nil
}

func archivePathIncluded(entryPath string, includes []string) bool {
	if len(includes) == 0 {
		return true
	}
	entryPath = strings.Trim(entryPath, "/")
	for _, include := range includes {
		if entryPath == include || strings.HasPrefix(entryPath, include+"/") {
			return true
		}
	}
	return false
}

func countIncludedZipEntries(files []*yzip.File, includes []string) (int, error) {
	total := 0
	for _, f := range files {
		entryPath, err := safeArchivePath(f.Name)
		if err != nil {
			return 0, newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", f.Name, err))
		}
		if archivePathIncluded(entryPath, includes) {
			total++
		}
	}
	return total, nil
}

func countIncludedSevenZipEntries(files []*sevenzip.File, includes []string) (int, error) {
	total := 0
	for _, f := range files {
		entryPath, err := safeArchivePath(f.Name)
		if err != nil {
			return 0, newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected archive path %q: %v", f.Name, err))
		}
		if archivePathIncluded(entryPath, includes) {
			total++
		}
	}
	return total, nil
}

func countIncludedRarEntries(entries []rarArchiveEntry, includes []string) int {
	total := 0
	for _, entry := range entries {
		if archivePathIncluded(entry.Path, includes) {
			total++
		}
	}
	return total
}

func rarEntriesContainEncrypted(entries []rarArchiveEntry) bool {
	for _, entry := range entries {
		if entry.Encrypted {
			return true
		}
	}
	return false
}

func discardRarEntry(ctx context.Context, r io.Reader, maxBytes int64, limitCode string) error {
	reader := &limitProgressReader{
		ctx:       ctx,
		r:         r,
		maxBytes:  maxBytes,
		limitCode: limitCode,
	}
	_, err := io.CopyBuffer(io.Discard, reader, make([]byte, 1024*1024))
	return err
}

func normalizePreviewListPath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "/" {
		return "/", nil
	}
	value = strings.Trim(value, "/")
	cleaned, err := safeArchivePath(value)
	if err != nil {
		return "", newError(http.StatusBadRequest, "PATH_REJECTED", fmt.Sprintf("Rejected preview path %q: %v", value, err))
	}
	return cleaned, nil
}

func finalizePreviewEntries(raw []previewEntry) []previewEntry {
	entries := map[string]previewEntry{}
	addDir := func(dir string, modTime time.Time, createdTime *time.Time) {}
	addDir = func(dir string, modTime time.Time, createdTime *time.Time) {
		dir = strings.Trim(strings.TrimSuffix(dir, "/"), "/")
		if dir == "" || dir == "." {
			return
		}
		parent := previewParentPath(dir)
		addDir(parent, time.Time{}, nil)
		key := "d:" + dir
		existing, ok := entries[key]
		if ok {
			if existing.ModTime.IsZero() && !modTime.IsZero() {
				existing.ModTime = modTime
			}
			if existing.CreatedTime == nil && createdTime != nil {
				existing.CreatedTime = createdTime
			}
			entries[key] = existing
			return
		}
		entries[key] = previewEntry{
			ID:          previewEntryID(dir, true),
			Path:        dir,
			Name:        path.Base(dir),
			Parent:      parent,
			IsDir:       true,
			Size:        0,
			ModTime:     modTime,
			CreatedTime: createdTime,
			MimeType:    "inode/directory",
			PreviewKind: "directory",
		}
	}

	for _, entry := range raw {
		entry.Path = strings.Trim(strings.TrimSuffix(entry.Path, "/"), "/")
		if entry.Path == "" || entry.Path == "." {
			continue
		}
		if entry.IsDir {
			addDir(entry.Path, entry.ModTime, entry.CreatedTime)
			continue
		}
		parent := previewParentPath(entry.Path)
		addDir(parent, time.Time{}, nil)
		entry.ID = previewEntryID(entry.Path, false)
		entry.Name = path.Base(entry.Path)
		entry.Parent = parent
		entry.MimeType = detectEntryMimeType(entry.Path)
		entry.PreviewKind = detectPreviewKind(entry.MimeType, entry.Path)
		entries["f:"+entry.Path] = entry
	}

	out := make([]previewEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Parent != out[j].Parent {
			return out[i].Parent < out[j].Parent
		}
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func previewParentPath(p string) string {
	parent := path.Dir(strings.Trim(p, "/"))
	if parent == "." || parent == "/" {
		return "/"
	}
	return parent
}

func previewEntryID(p string, isDir bool) string {
	prefix := "f:"
	if isDir {
		prefix = "d:"
	}
	sum := sha256.Sum256([]byte(prefix + p))
	return hex.EncodeToString(sum[:16])
}

func detectEntryMimeType(name string) string {
	ext := strings.ToLower(path.Ext(name))
	switch ext {
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".txt", ".log", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".conf", ".css", ".js", ".ts", ".html", ".htm", ".go", ".py", ".sh":
		if ext == ".json" {
			return "application/json; charset=utf-8"
		}
		if ext == ".csv" {
			return "text/csv; charset=utf-8"
		}
		if ext == ".html" || ext == ".htm" {
			return "text/html; charset=utf-8"
		}
		return "text/plain; charset=utf-8"
	}
	if value := mime.TypeByExtension(ext); value != "" {
		return value
	}
	return "application/octet-stream"
}

func detectPreviewKind(mimeType, name string) string {
	lowerMime := strings.ToLower(strings.Split(mimeType, ";")[0])
	lowerName := strings.ToLower(name)
	switch {
	case strings.HasPrefix(lowerMime, "text/"), lowerMime == "application/json", lowerMime == "application/xml":
		return "text"
	case strings.HasPrefix(lowerMime, "image/"):
		return "image"
	case lowerMime == "application/pdf":
		return "pdf"
	case strings.HasSuffix(lowerName, ".xlsx"), strings.HasSuffix(lowerName, ".xls"), strings.HasSuffix(lowerName, ".ods"),
		strings.HasSuffix(lowerName, ".docx"), strings.HasSuffix(lowerName, ".doc"), strings.HasSuffix(lowerName, ".odt"),
		strings.HasSuffix(lowerName, ".pptx"), strings.HasSuffix(lowerName, ".ppt"), strings.HasSuffix(lowerName, ".odp"):
		return "office"
	default:
		return "unsupported"
	}
}

func previewContainsEncryptedEntries(entries []previewEntry) bool {
	for _, entry := range entries {
		if entry.Encrypted {
			return true
		}
	}
	return false
}

func safeArchivePath(name string) (string, error) {
	if name == "" {
		return "", errors.New("empty name")
	}
	if strings.ContainsRune(name, 0) {
		return "", errors.New("NUL byte")
	}
	if strings.HasPrefix(name, `\\`) || strings.HasPrefix(name, "//") {
		return "", errors.New("UNC path")
	}
	if strings.Contains(name, `\`) {
		return "", errors.New("backslash path separator")
	}
	if windowsDrive.MatchString(name) {
		return "", errors.New("Windows drive path")
	}
	if path.IsAbs(name) {
		return "", errors.New("absolute path")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", errors.New("control character")
		}
	}
	cleaned := path.Clean(name)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("path traversal")
	}
	if len(cleaned) > 4096 {
		return "", errors.New("path too long")
	}
	for _, part := range strings.Split(cleaned, "/") {
		if part == "" || part == "." || part == ".." {
			return "", errors.New("invalid path component")
		}
		if len(part) > 255 {
			return "", errors.New("path component too long")
		}
	}
	return cleaned, nil
}

func zipHasWinZipAES(extra []byte) bool {
	for len(extra) >= 4 {
		id := binary.LittleEndian.Uint16(extra[0:2])
		size := int(binary.LittleEndian.Uint16(extra[2:4]))
		extra = extra[4:]
		if size > len(extra) {
			return false
		}
		if id == 0x9901 {
			return true
		}
		extra = extra[size:]
	}
	return false
}

func zipCreatedTime(extra []byte) time.Time {
	for len(extra) >= 4 {
		id := binary.LittleEndian.Uint16(extra[0:2])
		size := int(binary.LittleEndian.Uint16(extra[2:4]))
		extra = extra[4:]
		if size > len(extra) {
			return time.Time{}
		}
		data := extra[:size]
		if created := zipCreatedTimeFromExtraBlock(id, data); !created.IsZero() {
			return created
		}
		extra = extra[size:]
	}
	return time.Time{}
}

func zipCreatedTimeFromExtraBlock(id uint16, data []byte) time.Time {
	switch id {
	case 0x5455:
		return zipExtendedTimestampCreatedTime(data)
	case 0x000a:
		return zipNTFSCreatedTime(data)
	default:
		return time.Time{}
	}
}

func zipExtendedTimestampCreatedTime(data []byte) time.Time {
	if len(data) < 1 {
		return time.Time{}
	}
	flags := data[0]
	data = data[1:]
	if flags&0x01 != 0 {
		if len(data) < 4 {
			return time.Time{}
		}
		data = data[4:]
	}
	if flags&0x02 != 0 {
		if len(data) < 4 {
			return time.Time{}
		}
		data = data[4:]
	}
	if flags&0x04 == 0 || len(data) < 4 {
		return time.Time{}
	}
	seconds := binary.LittleEndian.Uint32(data[:4])
	return time.Unix(int64(seconds), 0).UTC()
}

func zipNTFSCreatedTime(data []byte) time.Time {
	if len(data) < 4 {
		return time.Time{}
	}
	data = data[4:]
	for len(data) >= 4 {
		tag := binary.LittleEndian.Uint16(data[0:2])
		size := int(binary.LittleEndian.Uint16(data[2:4]))
		data = data[4:]
		if size > len(data) {
			return time.Time{}
		}
		if tag == 0x0001 && size >= 24 {
			created := binary.LittleEndian.Uint64(data[16:24])
			return windowsFileTime(created)
		}
		data = data[size:]
	}
	return time.Time{}
}

func windowsFileTime(value uint64) time.Time {
	const windowsToUnixSeconds = 11644473600
	const ticksPerSecond = 10000000
	if value == 0 {
		return time.Time{}
	}
	seconds := int64(value/ticksPerSecond) - windowsToUnixSeconds
	nanos := int64(value%ticksPerSecond) * 100
	return time.Unix(seconds, nanos).UTC()
}

func optionalTime(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	return &value
}

func detectArchiveKind(name, mimeType string) string {
	lowerName := strings.ToLower(name)
	lowerMime := strings.ToLower(mimeType)
	switch {
	case strings.HasSuffix(lowerName, ".tar.gz"), strings.HasSuffix(lowerName, ".tgz"):
		return "tar.gz"
	case strings.HasSuffix(lowerName, ".tar"), lowerMime == "application/x-tar":
		return "tar"
	case strings.HasSuffix(lowerName, ".gz"), lowerMime == "application/gzip", lowerMime == "application/x-gzip":
		return "gz"
	case strings.HasSuffix(lowerName, ".zip"), lowerMime == "application/zip":
		return "zip"
	case strings.HasSuffix(lowerName, ".7z"), lowerMime == "application/x-7z-compressed":
		return "7z"
	case strings.HasSuffix(lowerName, ".rar"), lowerMime == "application/vnd.rar", lowerMime == "application/x-rar-compressed", lowerMime == "application/x-rar":
		return "rar"
	default:
		return ""
	}
}

func archiveReadError(err error) error {
	if err == nil {
		return nil
	}
	return newError(http.StatusBadRequest, "PASSWORD_OR_ARCHIVE_INVALID", "Archive password or archive data is invalid")
}

func zipReadError(err error) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "password"):
		return newError(http.StatusUnauthorized, "PASSWORD_OR_ARCHIVE_INVALID", "Archive password or archive data is invalid")
	case strings.Contains(msg, "authentication"):
		return newError(http.StatusUnauthorized, "PASSWORD_OR_ARCHIVE_INVALID", "Archive password or archive data is invalid")
	default:
		return archiveReadError(err)
	}
}

func rarReadError(err error, password string) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, rardecode.ErrArchiveEncrypted), errors.Is(err, rardecode.ErrArchivedFileEncrypted):
		if password == "" {
			return newError(http.StatusUnauthorized, "PASSWORD_REQUIRED", "Archive password is required")
		}
		return newError(http.StatusUnauthorized, "PASSWORD_OR_ARCHIVE_INVALID", "Archive password or archive data is invalid")
	case errors.Is(err, rardecode.ErrBadPassword):
		return newError(http.StatusUnauthorized, "PASSWORD_OR_ARCHIVE_INVALID", "Archive password or archive data is invalid")
	case errors.Is(err, rardecode.ErrMultiVolume):
		return newError(http.StatusBadRequest, "MULTIVOLUME_UNSUPPORTED", "RAR multi-volume archives are not supported")
	case errors.Is(err, rardecode.ErrDictionaryTooLarge):
		return newError(http.StatusRequestEntityTooLarge, "RAR_DICTIONARY_TOO_LARGE", "RAR decode dictionary exceeds configured size limit")
	default:
		return archiveReadError(err)
	}
}

func rarStreamError(err error, password string) error {
	if err == nil {
		return nil
	}
	var appErr *appError
	if errors.As(err, &appErr) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return rarReadError(err, password)
}

func compressionOutputInfo(req compressionRequest) outputInfo {
	if req.Output.Mode == outputDownload {
		return outputInfo{Mode: outputDownload}
	}
	return outputInfo{Mode: outputSave, ResourcePath: joinDavPath(req.Output.Destination.FolderPath, archiveOutputName(req))}
}

func downloadJobURL(j *job) string {
	value := "/archive/api/jobs/" + url.PathEscape(j.ID) + "/download"
	if j.DownloadToken == "" {
		return value
	}
	return value + "?token=" + url.QueryEscape(j.DownloadToken)
}

func previewEntryDownloadURL(previewID, entryID, token string) string {
	return "/archive/api/previews/" + url.PathEscape(previewID) + "/entries/" + url.PathEscape(entryID) + "/content?download=1&token=" + url.QueryEscape(token)
}

func archiveOutputName(req compressionRequest) string {
	name := req.Output.FileName
	if req.Output.Mode == outputSave && req.Output.Destination.FileName != "" {
		name = req.Output.Destination.FileName
	}
	if name == "" {
		if len(req.Sources) == 1 && req.Sources[0].Name != "" {
			name = req.Sources[0].Name
		} else {
			name = "archive"
		}
	}
	ext := ".zip"
	if req.Format == "tar.gz" || req.Format == "tgz" {
		ext = ".tar.gz"
	}
	if !strings.HasSuffix(strings.ToLower(name), ext) {
		name += ext
	}
	name = strings.Map(func(r rune) rune {
		switch {
		case r == '"', r == '/', r == '\\':
			return -1
		case unicode.IsControl(r):
			return -1
		default:
			return r
		}
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "archive" + ext
	}
	return name
}

func archiveContentType(format string) string {
	switch format {
	case "tar.gz", "tgz":
		return "application/gzip"
	default:
		return "application/zip"
	}
}

func contentDisposition(filename string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": filename})
}

func inlineContentDisposition(filename string) string {
	return mime.FormatMediaType("inline", map[string]string{"filename": filename})
}

func tempSiblingPath(finalPath, jobID string) string {
	dir := path.Dir(finalPath)
	base := path.Base(finalPath)
	return joinDavPath(dir, fmt.Sprintf("._file_archiver_tmp_%s_%s.part", jobID, base))
}

func encodePathSegments(p string) string {
	return strings.Join(mapNonEmpty(strings.Split(p, "/"), url.PathEscape), "/")
}

func cleanDavPath(p string) string {
	if p == "" {
		return "/"
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(p, "/"))
	if cleaned == "." {
		return "/"
	}
	return cleaned
}

func joinDavPath(root, child string) string {
	if child == "" || child == "." {
		return cleanDavPath(root)
	}
	return cleanDavPath(strings.TrimRight(root, "/") + "/" + strings.TrimLeft(child, "/"))
}

func ensureTrailingSlash(p string) string {
	if strings.HasSuffix(p, "/") {
		return p
	}
	return p + "/"
}

func mapNonEmpty(values []string, fn func(string) string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		out = append(out, fn(value))
	}
	return out
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func hashAuth(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"code":"INTERNAL","error":"failed to marshal response"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := "INTERNAL"
	message := err.Error()
	var appErr *appError
	if errors.As(err, &appErr) {
		status = appErr.Status
		code = appErr.Code
		message = appErr.Message
	}
	writeJSON(w, status, map[string]string{"code": code, "error": message})
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
