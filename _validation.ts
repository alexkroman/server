// Copyright 2025 the AAI authors. MIT license.
// Local zValidator — same API as @hono/zod-validator, compatible with Zod 4.
import { validator } from "hono/validator";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

export function zValidator<S extends z.ZodType>(target: "json", schema: S) {
  return validator(target, (value) => {
    const result = schema.safeParse(value);
    if (!result.success) throw new HTTPException(400, { message: "Invalid request body" });
    return result.data as z.infer<S>;
  });
}
