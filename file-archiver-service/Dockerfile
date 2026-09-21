FROM golang:1.27.1-alpine@sha256:4cb7ac979db5fcc41cae44b2227ba5ab8a51e8807f40d9ba4dee20a0ad960b5b AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/file-archiver-service ./cmd/file-archiver-service

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# Security fixes can precede the next pinned Alpine image.
RUN apk upgrade --no-cache libcrypto3 libssl3 \
  && addgroup -S archiver \
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
