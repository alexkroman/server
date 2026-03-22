// Copyright 2025 the AAI authors. MIT license.
import { assertRejects } from "@std/assert";
import { assertPublicUrl } from "./_net.ts";

Deno.test("assertPublicUrl blocks localhost", async () => {
  await assertRejects(
    () => assertPublicUrl("http://127.0.0.1/"),
    Error,
    "Blocked request to private address",
  );
});

Deno.test("assertPublicUrl blocks private IP", async () => {
  await assertRejects(
    () => assertPublicUrl("http://192.168.1.1/"),
    Error,
    "Blocked request to private address",
  );
});
