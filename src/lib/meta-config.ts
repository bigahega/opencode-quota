import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getAuthPaths, readAuthFile } from "./opencode-auth.js";

export interface MetaApiKeyResult {
  key: string;
  source: MetaKeySource;
}

export type MetaKeySource =
  | "env:META_MODEL_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const metaApiKeyResolver = createProviderApiKeyResolver<MetaKeySource>({
  envVars: [{ name: "META_MODEL_API_KEY", source: "env:META_MODEL_API_KEY" }],
  providerKeys: ["meta"],
  allowedEnvVars: ["META_MODEL_API_KEY"],
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    getAuthPaths,
    authSource: "auth.json",
  },
});

export async function resolveMetaApiKey(): Promise<MetaApiKeyResult | null> {
  return metaApiKeyResolver.resolve();
}

export async function hasMetaApiKey(): Promise<boolean> {
  return metaApiKeyResolver.has();
}

export async function getMetaKeyDiagnostics(): Promise<{
  configured: boolean;
  source: MetaKeySource | null;
  checkedPaths: string[];
  authPaths: string[];
}> {
  return metaApiKeyResolver.diagnostics();
}
