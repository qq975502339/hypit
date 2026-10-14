import { request as httpsRequest } from "node:https";
import { defineEndpointPackage, wakeAfter } from "@hypit/endpoint-kit";
import type { AsyncEndpoint, EndpointInvocationContext, EndpointOutcome } from "@hypit/endpoint-kit";
import { generationTypes, sealGeneratedAudioSet, sealGeneratedImageSet, sealGeneratedVideoSet } from "@hypit/generation";
import type { GenerationRequest } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef, CanonicalValue } from "@hypit/protocol";
import { credentialRef } from "@hypit/runtime";
import type { CredentialRef } from "@hypit/runtime";
import { autoDlH3Resolution, selectAutoDlH3Workflow } from "./autodl-h3-workflows.js";

export const localAiProviderModuleRef = { name: "@hypit/provider-local-ai", version: "1" } as const;
const imageCapability = { module: { name: "@hypit/gpt-image", version: "1" }, name: "gpt-image-2" } as const;
const videoCapability = { module: { name: "@hypit/minimax-h3", version: "1" }, name: "minimax-h3" } as const;
const speechCapabilities = [
  { module: { name: "@hypit/mimo-speech", version: "1" }, name: "mimo-v2.5-tts-voicedesign" },
  { module: { name: "@hypit/mimo-speech", version: "1" }, name: "mimo-v2.5-tts-voiceclone" },
] as const;

type Handle = { readonly media: "image" | "audio" | "video"; readonly service?: "autodl"; readonly url?: string; readonly taskId?: string; readonly startedAt: number };
export type CreateLocalAiProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  readonly autodlToken?: CredentialRef;
  readonly dashscopeApiKey?: CredentialRef;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  /** Select one exact current AutoDL H3 workflow instead of automatic quality-first routing. */
  readonly h3WorkflowId?: string;
  readonly fetch?: typeof globalThis.fetch;
};

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function record(value: unknown, message: string): Record<string, unknown> { assert(value !== null && typeof value === "object" && !Array.isArray(value), message); return value as Record<string, unknown>; }
function text(value: unknown, message: string): string { assert(typeof value === "string" && value.length > 0, message); return value; }
function request(context: EndpointInvocationContext): GenerationRequest { return context.need.constraints as unknown as GenerationRequest; }
function scalar(context: EndpointInvocationContext, port: string): string | number | boolean | undefined { return request(context).ports[port]?.[0] as string | number | boolean | undefined; }
function key(context: EndpointInvocationContext, name: "autodlToken" | "dashscopeApiKey"): string { return text(context.credentials[name]?.secret, `${name} credential is unavailable`); }
function capabilityName(context: EndpointInvocationContext): string { return context.need.capability.name; }
function urls(value: unknown): string[] {
  if (typeof value === "string" && /^https?:\/\//u.test(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(urls);
  if (value !== null && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(urls);
  return [];
}
function dashscopeImageOutput(body: unknown): Record<string, unknown> {
  const response = record(body, "DashScope Qwen Image response is invalid");
  if (typeof response.code === "string" && response.code.length > 0) {
    const message = typeof response.message === "string" && response.message.trim().length > 0
      ? response.message.trim().replace(/\s+/gu, " ").slice(0, 300)
      : "no reason was returned";
    throw new Error(`DashScope Qwen Image rejected request (${response.code}): ${message}`);
  }
  return record(response.output, "DashScope Qwen Image response has no output");
}
async function dashscopeImageResponse(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`DashScope Qwen Image returned HTTP ${response.status}`); }
  if (!response.ok) {
    const recordBody = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    if (typeof recordBody?.code === "string") return dashscopeImageOutput(recordBody);
    throw new Error(`DashScope Qwen Image returned HTTP ${response.status}`);
  }
  return dashscopeImageOutput(body);
}
function autodlData(body: unknown, operation: string): Record<string, unknown> {
  const response = record(body, `AutoDL ${operation} response is invalid`);
  if (typeof response.code === "string" && response.code !== "Success") {
    const message = typeof response.msg === "string" && response.msg.trim().length > 0
      ? response.msg.trim().replace(/\s+/gu, " ").slice(0, 300)
      : "no reason was returned";
    throw new Error(`AutoDL H3 ${operation} rejected (${response.code}): ${message}`);
  }
  return record(response.data, `AutoDL ${operation} data is invalid`);
}
function dashscopeImageSize(aspectRatio: unknown): "1664*928" | "1328*1328" | "928*1664" {
  if (aspectRatio === "1:1") return "1328*1328";
  if (aspectRatio === "9:16") return "928*1664";
  return "1664*928";
}
function mediaType(media: Handle["media"]): string { return media === "image" ? "image/png" : media === "audio" ? "audio/mpeg" : "video/mp4"; }
function result(media: Handle["media"], artifacts: readonly BlobRef[]) {
  return media === "image" ? sealGeneratedImageSet({ images: artifacts })
    : media === "audio" ? sealGeneratedAudioSet({ audios: artifacts }) : sealGeneratedVideoSet({ videos: artifacts });
}

function audioFilename(mediaType: string): string {
  if (mediaType === "audio/mpeg") return "voice-reference.mp3";
  if (mediaType === "audio/mp4") return "voice-reference.m4a";
  return "voice-reference.wav";
}

function media(context: EndpointInvocationContext, port: string, expectedType: "image" | "audio" | "video"): readonly BlobRef[] {
  return (request(context).ports[port] ?? []).map((value, index) => {
    const entry = record(value, `AutoDL H3 ${port}[${index}] is invalid`);
    const artifact = record(entry.artifact, `AutoDL H3 ${port}[${index}] has no Artifact`) as unknown as BlobRef;
    assert(artifact.kind === "blob" && artifact.mediaType.startsWith(`${expectedType}/`),
      `AutoDL H3 ${port}[${index}] must be ${expectedType} media`);
    return artifact;
  });
}

async function dataUrl(artifact: BlobRef, context: EndpointInvocationContext): Promise<string> {
  const bytes = await context.resources.get(artifact.resource);
  assert(bytes !== undefined && bytes.byteLength === artifact.size,
    `AutoDL H3 reference ${artifact.resource} is unavailable or has changed`);
  // DashScope returns generated WAV files as audio/x-wav, while AutoDL's H3
  // workflows whitelist the equivalent IANA spelling audio/wav.
  const contentType = artifact.mediaType === "audio/x-wav" ? "audio/wav" : artifact.mediaType;
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * CosyVoice receives a URL for voice enrollment.  The DashScope temporary store
 * is deliberately used here so a local source file does not need to be made
 * public or copied into the user's own OSS bucket.
 */
async function dashscopeTemporaryAudioUrl(
  artifact: BlobRef,
  context: EndpointInvocationContext,
  fetcher: typeof globalThis.fetch,
): Promise<string> {
  const policyResponse = await fetcher("https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=cosyvoice-v3.5-plus", {
    headers: { authorization: `Bearer ${key(context, "dashscopeApiKey")}`, "content-type": "application/json" },
  });
  assert(policyResponse.ok, `DashScope temporary upload policy returned HTTP ${policyResponse.status}`);
  const policy = record(record(await policyResponse.json(), "DashScope temporary upload policy is invalid").data,
    "DashScope temporary upload policy has no data");
  const uploadHost = text(policy.upload_host, "DashScope temporary upload policy has no upload_host");
  const uploadDir = text(policy.upload_dir, "DashScope temporary upload policy has no upload_dir");
  const uploadKey = `${uploadDir}/${audioFilename(artifact.mediaType)}`;
  const bytes = await context.resources.get(artifact.resource);
  assert(bytes !== undefined && bytes.byteLength === artifact.size,
    `DashScope voice reference ${artifact.resource} is unavailable or has changed`);
  const form = new FormData();
  form.set("OSSAccessKeyId", text(policy.oss_access_key_id, "DashScope temporary upload policy has no oss_access_key_id"));
  form.set("policy", text(policy.policy, "DashScope temporary upload policy has no policy"));
  form.set("Signature", text(policy.signature, "DashScope temporary upload policy has no signature"));
  form.set("key", uploadKey);
  form.set("x-oss-object-acl", text(policy.x_oss_object_acl, "DashScope temporary upload policy has no x_oss_object_acl"));
  form.set("x-oss-forbid-overwrite", text(policy.x_oss_forbid_overwrite, "DashScope temporary upload policy has no x_oss_forbid_overwrite"));
  form.set("success_action_status", "200");
  form.set("file", new Blob([Uint8Array.from(bytes)], { type: artifact.mediaType }), audioFilename(artifact.mediaType));
  const uploaded = await fetcher(uploadHost, { method: "POST", body: form });
  assert(uploaded.ok, `DashScope temporary audio upload returned HTTP ${uploaded.status}`);
  return `oss://${uploadKey}`;
}

async function cosyVoiceClone(
  context: EndpointInvocationContext,
  fetcher: typeof globalThis.fetch,
): Promise<{ readonly url: string }> {
  const speech = text(scalar(context, "text"), "CosyVoice TTS requires text");
  const [reference] = media(context, "voiceReference", "audio");
  assert(reference !== undefined, "CosyVoice voice clone requires one audio reference");
  const referenceUrl = await dashscopeTemporaryAudioUrl(reference, context, fetcher);
  const headers = {
    authorization: `Bearer ${key(context, "dashscopeApiKey")}`,
    "content-type": "application/json",
    "X-DashScope-OssResourceResolve": "enable",
  };
  const enrolled = await fetcher("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST", headers,
    body: JSON.stringify({
      model: "voice-enrollment",
      input: {
        action: "create_voice", target_model: "cosyvoice-v3.5-plus", prefix: "hypit", url: referenceUrl,
        language_hints: ["zh"], max_prompt_audio_length: 30, enable_preprocess: true, enable_volume_normalization: "false",
      },
    }),
  });
  assert(enrolled.ok, `DashScope CosyVoice voice enrollment returned HTTP ${enrolled.status}`);
  const voiceId = text(record(record(await enrolled.json(), "DashScope CosyVoice voice enrollment is invalid").output,
    "DashScope CosyVoice voice enrollment has no output").voice_id, "DashScope CosyVoice voice enrollment has no voice_id");
  const instruction = scalar(context, "instruction");
  assert(instruction === undefined || typeof instruction === "string", "CosyVoice instruction must be text");
  const synthesized = await fetcher("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer", {
    method: "POST", headers,
    body: JSON.stringify({
      model: "cosyvoice-v3.5-plus",
      input: { text: speech, voice: voiceId, format: "wav", sample_rate: 24000, ...(instruction === undefined ? {} : { instruction }) },
    }),
  });
  assert(synthesized.ok, `DashScope CosyVoice synthesis returned HTTP ${synthesized.status}`);
  const url = urls(await synthesized.json())[0];
  assert(url !== undefined, "DashScope CosyVoice response has no audio URL");
  return { url };
}

/**
 * AutoDL accepts multi-megabyte Base64 reference media. Node's built-in fetch
 * applies a five-minute response-header deadline, which can expire while
 * AutoDL is staging that media before it creates a task. Use the Node HTTPS
 * transport for the real runtime and retain injected fetch for deterministic
 * tests.
 */
async function submitAutoDl(
  fetcher: typeof globalThis.fetch,
  workflowId: string,
  body: Record<string, unknown>,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  const url = `https://autodl.art/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`;
  const serialized = JSON.stringify(body);
  const init = {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: serialized,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (fetcher !== globalThis.fetch) return await fetcher(url, init);
  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json", "content-length": Buffer.byteLength(serialized) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(Uint8Array.from(Buffer.concat(chunks)), { status: response.statusCode ?? 500, headers }));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`AutoDL submission timed out after ${timeoutMs}ms`)));
    request.on("error", reject);
    request.end(serialized);
  });
}

async function queryAutoDl(
  fetcher: typeof globalThis.fetch,
  taskId: string,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  const url = `https://autodl.art/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`;
  const init = { headers: { authorization: token }, signal: AbortSignal.timeout(timeoutMs) };
  if (fetcher !== globalThis.fetch) return await fetcher(url, init);
  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(url, { method: "GET", headers: { authorization: token } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(Uint8Array.from(Buffer.concat(chunks)), { status: response.statusCode ?? 500, headers }));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`AutoDL status query timed out after ${timeoutMs}ms`)));
    request.on("error", reject);
    request.end();
  });
}

async function autoDlH3Body(context: EndpointInvocationContext, configuredWorkflowId: string | undefined): Promise<{ readonly workflowId: string; readonly body: Record<string, unknown> }> {
  const prompt = text(scalar(context, "prompt"), "AutoDL H3 requires prompt");
  const duration = scalar(context, "duration"); assert(typeof duration === "number", "AutoDL H3 requires duration");
  const images = media(context, "referenceImage", "image");
  const audio = media(context, "referenceAudio", "audio");
  const videos = media(context, "referenceVideo", "video");
  const firstFrames = media(context, "firstFrame", "image");
  const lastFrames = media(context, "lastFrame", "image");
  const aspectRatio = scalar(context, "aspectRatio");
  assert(aspectRatio === undefined || typeof aspectRatio === "string", "AutoDL H3 aspectRatio must be text");
  const workflow = selectAutoDlH3Workflow({
    images: images.length,
    audio: audio.length,
    referenceVideo: videos.length,
    firstFrame: firstFrames.length === 1,
    lastFrame: lastFrames.length === 1,
    duration,
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
  }, configuredWorkflowId);
  const body: Record<string, unknown> = {
    [workflow.durationField]: duration,
    resolution: autoDlH3Resolution(workflow, aspectRatio),
  };
  if (workflow.kind !== "audio-sync") body.prompt = prompt;
  if (workflow.kind === "frames") {
    body.first_frame = await dataUrl(firstFrames[0]!, context);
    body.last_frame = await dataUrl(lastFrames[0]!, context);
  } else {
    for (const [index, artifact] of images.entries()) body[`ref_image_${index}`] = await dataUrl(artifact, context);
    for (const [index, artifact] of audio.entries()) body[`ref_audio_${index}`] = await dataUrl(artifact, context);
  }
  return { workflowId: workflow.id, body };
}

function endpoint(
  fetcher: typeof globalThis.fetch,
  pollIntervalMs: number,
  h3WorkflowId: string | undefined,
  requestTimeoutMs: number,
): AsyncEndpoint {
  const download = async (url: string, media: Handle["media"], context: EndpointInvocationContext): Promise<EndpointOutcome> => {
    const response = await fetcher(url); assert(response.ok, `generated ${media} download returned HTTP ${response.status}`);
    const artifact = await context.resources.put(new Uint8Array(await response.arrayBuffer()), response.headers.get("content-type")?.split(";", 1)[0] ?? mediaType(media));
    return { status: "completed", result: { value: { kind: "inline", value: canonicalize(result(media, [artifact])) } } };
  };
  return {
    async start(context) {
      const name = capabilityName(context);
      if (name === imageCapability.name) {
        const prompt = text(scalar(context, "prompt"), "DashScope Qwen Image requires prompt");
        const response = await fetcher("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", { method: "POST", headers: { authorization: `Bearer ${key(context, "dashscopeApiKey")}`, "content-type": "application/json" }, body: JSON.stringify({ model: "qwen-image-3.0", input: { messages: [{ role: "user", content: [{ text: prompt }] }] }, parameters: { size: dashscopeImageSize(scalar(context, "aspectRatio")), prompt_extend: true, watermark: false } }) });
        const url = urls(await dashscopeImageResponse(response))[0];
        assert(url !== undefined, "DashScope Qwen Image response has no image URL");
        return { status: "ready", handle: canonicalize({ media: "image", url, startedAt: Date.now() }) };
      }
      if (name === videoCapability.name) {
        const prepared = await autoDlH3Body(context, h3WorkflowId);
        const response = await submitAutoDl(fetcher, prepared.workflowId, prepared.body, key(context, "autodlToken"), requestTimeoutMs);
        assert(response.ok, `AutoDL H3 submission returned HTTP ${response.status}`);
        const taskId = text(autodlData(await response.json(), "submission").task_id, "AutoDL response has no task_id");
        const handle: Handle = { media: "video", service: "autodl", taskId, startedAt: Date.now() };
        const receipt = { id: taskId };
        await context.checkpoint?.({ handle: canonicalize(handle), receipt });
        return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: "submitted" }), receipt };
      }
      if (name === "mimo-v2.5-tts-voiceclone") {
        const cloned = await cosyVoiceClone(context, fetcher);
        return { status: "ready", handle: canonicalize({ media: "audio", url: cloned.url, startedAt: Date.now() }) };
      }
      const speech = text(scalar(context, "text"), "DashScope TTS requires text");
      const response = await fetcher("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", { method: "POST", headers: { authorization: `Bearer ${key(context, "dashscopeApiKey")}`, "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3-tts-flash", input: { text: speech, voice: "Cherry", language_type: /[\u3400-\u9fff]/u.test(speech) ? "Chinese" : "English" } }) });
      assert(response.ok, `DashScope Qwen3 TTS returned HTTP ${response.status}`);
      const url = urls(await response.json())[0]; assert(url !== undefined, "DashScope Qwen3 TTS response has no audio URL");
      return { status: "ready", handle: canonicalize({ media: "audio", url, startedAt: Date.now() }) };
    },
    async poll(context) {
      const handle = context.handle as unknown as Handle;
      assert(typeof handle.taskId === "string", "Local AI Provider poll handle is invalid");
      assert(handle.media === "video" && handle.service === "autodl", "Local AI Provider poll handle is invalid");
      let response: Response | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          response = await queryAutoDl(fetcher, handle.taskId, key(context, "autodlToken"), Math.min(requestTimeoutMs, 30_000));
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (response === undefined) throw lastError;
      assert(response.ok, `AutoDL H3 status returned HTTP ${response.status}`);
      const data = autodlData(await response.json(), "status query");
      const status = text(data.status, "AutoDL status is missing");
      if (status === "QUEUED" || status === "RUNNING") return wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: status });
      if (status === "FAILED") return { status: "failed", failure: { code: "AUTODL_TASK_FAILED", message: `AutoDL H3 task ${handle.taskId} failed` }, receipt: { id: handle.taskId } };
      assert(status === "SUCCESS", `AutoDL H3 returned unknown status ${status}`);
      const url = urls(data.results)[0]; assert(url !== undefined, "AutoDL H3 result has no video URL");
      return { status: "ready", handle: canonicalize({ ...handle, url }), receipt: { id: handle.taskId } };
    },
    async collect(context) { const handle = context.handle as unknown as Handle; assert(handle.url !== undefined, "Local AI Provider collection handle has no URL"); return await download(handle.url, handle.media, context); },
  };
}

export function createLocalAiProvider(options: CreateLocalAiProviderOptions = {}) {
  const asyncEndpoint = endpoint(
    options.fetch ?? globalThis.fetch,
    options.pollIntervalMs ?? 5_000,
    options.h3WorkflowId,
    options.requestTimeoutMs ?? 600_000,
  );
  return defineEndpointPackage({
    module: localAiProviderModuleRef, facet: "gateway", instance: options.instance ?? "local-ai.default", pool: options.pool ?? options.instance ?? "local-ai.default",
    credentials: { autodlToken: options.autodlToken ?? credentialRef("os", "autodl.comfyui-token"), dashscopeApiKey: options.dashscopeApiKey ?? credentialRef("os", "dashscope.api-key") },
    credentialInputs: { autodlToken: { label: "AutoDL ComfyUI token" }, dashscopeApiKey: { label: "DashScope API key" } },
    capabilities: [
      { capability: imageCapability, returns: generationTypes.imageSet, lifecycle: "asynchronous" as const, endpoint: asyncEndpoint, capacity: "minimax-image-01" },
      { capability: videoCapability, returns: generationTypes.videoSet, lifecycle: "asynchronous" as const, endpoint: asyncEndpoint, capacity: "autodl-minimax-h3-b99-001" },
      ...speechCapabilities.map((capability) => ({ capability, returns: generationTypes.audioSet, lifecycle: "asynchronous" as const, endpoint: asyncEndpoint, capacity: "dashscope-qwen3-tts-flash" })),
    ],
  });
}
