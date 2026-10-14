import { createRuntimeEndpointAdapterFacet, runtimeConfigCredentialRef, runtimeConfigExact, runtimeConfigObject, runtimeConfigPositiveInteger, runtimeConfigString } from "@hypit/runtime-kit";
import { createLocalAiProvider } from "./provider.js";

const adapter = createRuntimeEndpointAdapterFacet({ use: "@hypit/provider-local-ai", activate(context) {
  if (context.pool === undefined) throw new Error("Local AI Provider Pool is required");
  const config = runtimeConfigObject(context.config, "Local AI Provider");
  runtimeConfigExact(config, ["autodlToken", "dashscopeApiKey", "pollIntervalMs", "h3WorkflowId"], "Local AI Provider");
  const autodlToken = runtimeConfigCredentialRef(config.autodlToken, "Local AI Provider autodlToken");
  const dashscopeApiKey = runtimeConfigCredentialRef(config.dashscopeApiKey, "Local AI Provider dashscopeApiKey");
  if (autodlToken === undefined || dashscopeApiKey === undefined) throw new Error("Local AI Provider requires autodlToken and dashscopeApiKey CredentialRefs");
  const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "Local AI Provider pollIntervalMs");
  const h3WorkflowId = runtimeConfigString(config.h3WorkflowId, "Local AI Provider h3WorkflowId");
  return { endpoint: createLocalAiProvider({ instance: context.instance, pool: context.pool, autodlToken, dashscopeApiKey,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }), ...(h3WorkflowId === undefined ? {} : { h3WorkflowId }) }) };
} });
export const hypitPackage = { format: "hypit.node-package@1" as const, hostFacets: [adapter] };
export default hypitPackage;
