FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/file-archiver-service ./cmd/file-archiver-service

FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

RUN addgroup -S archiver \
  && adduser -S -G archiver archiver \
  && mkdir -p /tmp/opencloud-file-archiver \
  && chown archiver:archiver /tmp/opencloud-file-archiver
USER archiver

ENV PORT=8080
ENV FILE_ARCHIVER_TMP_DIR=/tmp/opencloud-file-archiver

WORKDIR /app
COPY --from=build /out/file-archiver-service /app/file-archiver-service

EXPOSE 8080
ENTRYPOINT ["/app/file-archiver-service"]
