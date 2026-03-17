// Copyright 2025 the AAI authors. MIT license.
import { DEFAULT_S2S_CONFIG, type S2SConfig } from "./types.ts";
import { EnvSchema } from "./_schemas.ts";

export type PlatformConfig = {
  apiKey: string;
  s2sConfig: S2SConfig;
};

export function loadPlatformConfig(
  env: Record<string, string | undefined>,
): PlatformConfig {
  const parsed = EnvSchema.parse(env);

  return {
    apiKey: parsed.ASSEMBLYAI_API_KEY,
    s2sConfig: { ...DEFAULT_S2S_CONFIG },
  };
}
