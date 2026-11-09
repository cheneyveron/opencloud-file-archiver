FROM golang:1.27.3-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/file-archiver-service ./cmd/file-archiver-service

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

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
