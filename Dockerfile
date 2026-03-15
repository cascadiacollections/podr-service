FROM golang:1.24-alpine AS build
WORKDIR /app
COPY container_src/main.go .
RUN CGO_ENABLED=0 GOOS=linux go build -o server main.go

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /app/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
