FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/file-archiver-service ./cmd/file-archiver-service

FROM alpine:3.22

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
