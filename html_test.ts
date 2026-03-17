// Copyright 2025 the AAI authors. MIT license.
import { assertStringIncludes } from "@std/assert";
import { renderLandingPage } from "./html.tsx";

Deno.test("renderLandingPage includes install command", () => {
  const html = renderLandingPage();
  assertStringIncludes(html, "curl -fsSL");
});
