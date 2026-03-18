FROM denoland/deno:2.7.2 AS build

WORKDIR /app
COPY . .

RUN deno compile \
  --allow-all \
  --target x86_64-unknown-linux-gnu \
  --output /app/dist/server \
  main.ts

FROM gcr.io/distroless/cc-debian12:nonroot

COPY --from=build /app/dist/server /server

EXPOSE 8080

ENTRYPOINT ["/server"]
