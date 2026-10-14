export type AutoDlH3WorkflowKind = "text" | "references" | "frames" | "audio-sync";

export type AutoDlH3Workflow = {
  readonly id: string;
  readonly name: string;
  readonly kind: AutoDlH3WorkflowKind;
  readonly minimumImages: number;
  readonly maximumImages: number;
  readonly minimumAudio: number;
  readonly maximumAudio: number;
  readonly maximumDuration: number;
  readonly durationField: "duration" | "audio_duration";
  readonly resolutions: Readonly<Partial<Record<"9:16" | "16:9" | "1:1", string>>>;
};

const highReferenceResolutions = {
  "9:16": "768p竖(768*1376)",
  "16:9": "768p横(1376*768)",
} as const;
const highTextResolutions = {
  "9:16": "768p竖(768*1344)",
  "16:9": "768p横(1344*768)",
} as const;
const commonResolutions = {
  "9:16": "768p竖",
  "16:9": "768p横",
  "1:1": "768p(1:1)",
} as const;
const b99Resolutions = {
  "9:16": "736p竖",
  "16:9": "736p横",
  "1:1": "736p(1:1)",
} as const;

/**
 * Snapshot of AutoDL's public H3 catalogue, read on 2026-10-13. Entries are
 * declarative because every workflow shares the same submission/poll contract
 * while their accepted reference-media shape differs.
 */
export const autoDlH3Workflows: readonly AutoDlH3Workflow[] = [
  { id: "minimax_h3_z0903", name: "H3六图三音频生视频（高质量音画融合）", kind: "references", minimumImages: 1, maximumImages: 6, minimumAudio: 1, maximumAudio: 3, maximumDuration: 15, durationField: "duration", resolutions: highReferenceResolutions },
  { id: "minimax_h3_z0902", name: "H3六图生视频（多图一致性创作）", kind: "references", minimumImages: 1, maximumImages: 6, minimumAudio: 0, maximumAudio: 0, maximumDuration: 15, durationField: "duration", resolutions: highReferenceResolutions },
  { id: "minimax_h3_z0901", name: "H3文生视频（高质量创意直出）", kind: "text", minimumImages: 0, maximumImages: 0, minimumAudio: 0, maximumAudio: 0, maximumDuration: 15, durationField: "duration", resolutions: highTextResolutions },
  { id: "minimax_h3_zm_u24", name: "H3多图多音频生视频（升级画质）", kind: "references", minimumImages: 1, maximumImages: 9, minimumAudio: 0, maximumAudio: 3, maximumDuration: 15, durationField: "duration", resolutions: commonResolutions },
  { id: "minimax_h3_zm_u08", name: "H3多图多音频生视频（高速版）", kind: "references", minimumImages: 1, maximumImages: 9, minimumAudio: 0, maximumAudio: 3, maximumDuration: 15, durationField: "duration", resolutions: commonResolutions },
  { id: "minimax_h3_b99_002", name: "H3首尾帧生成视频", kind: "frames", minimumImages: 0, maximumImages: 0, minimumAudio: 0, maximumAudio: 0, maximumDuration: 15, durationField: "duration", resolutions: b99Resolutions },
  { id: "minimax_h3_b99_001", name: "H3文生视频", kind: "text", minimumImages: 0, maximumImages: 0, minimumAudio: 0, maximumAudio: 0, maximumDuration: 15, durationField: "duration", resolutions: b99Resolutions },
  { id: "minimax_h3_b99_003_12s", name: "H3多图生视频12秒", kind: "references", minimumImages: 1, maximumImages: 9, minimumAudio: 0, maximumAudio: 0, maximumDuration: 12, durationField: "duration", resolutions: b99Resolutions },
  { id: "minimax_h3_image_audio_to_video_v2_15s", name: "H3多图多音频生视频15秒", kind: "references", minimumImages: 1, maximumImages: 9, minimumAudio: 0, maximumAudio: 3, maximumDuration: 15, durationField: "duration", resolutions: commonResolutions },
  { id: "minimax_h3_lightx2v_v5_15s", name: "H3多图生视频15秒", kind: "references", minimumImages: 1, maximumImages: 9, minimumAudio: 0, maximumAudio: 0, maximumDuration: 15, durationField: "duration", resolutions: commonResolutions },
  { id: "minimax_h3_image_audio_to_video_v2", name: "H3多图多音频生视频", kind: "references", minimumImages: 1, maximumImages: 9, minimumAudio: 0, maximumAudio: 3, maximumDuration: 15, durationField: "duration", resolutions: commonResolutions },
  { id: "minimax_h3_image_audio_to_video", name: "H3图生视频-音频同步（自动对口型）", kind: "audio-sync", minimumImages: 1, maximumImages: 1, minimumAudio: 1, maximumAudio: 1, maximumDuration: 15, durationField: "audio_duration", resolutions: commonResolutions },
  { id: "minimax_h3_lightx2v_v5", name: "H3多图参考生视频", kind: "references", minimumImages: 1, maximumImages: 9, minimumAudio: 0, maximumAudio: 0, maximumDuration: 15, durationField: "duration", resolutions: commonResolutions },
  { id: "minimax_h3_lightx2v_no_pic", name: "H3文生视频", kind: "text", minimumImages: 0, maximumImages: 0, minimumAudio: 0, maximumAudio: 0, maximumDuration: 15, durationField: "duration", resolutions: commonResolutions },
  { id: "minimax_h3_lightx2v", name: "H3首尾帧生成视频", kind: "frames", minimumImages: 0, maximumImages: 0, minimumAudio: 0, maximumAudio: 0, maximumDuration: 15, durationField: "duration", resolutions: commonResolutions },
];

export type AutoDlH3RequestShape = {
  readonly images: number;
  readonly audio: number;
  readonly firstFrame: boolean;
  readonly lastFrame: boolean;
  readonly referenceVideo: number;
  readonly duration: number;
  readonly aspectRatio?: string;
};

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function compatible(workflow: AutoDlH3Workflow, request: AutoDlH3RequestShape): boolean {
  if (request.referenceVideo > 0) return false;
  if (workflow.kind === "frames") return request.firstFrame && request.lastFrame && request.images === 0 && request.audio === 0;
  if (request.firstFrame || request.lastFrame) return false;
  if (workflow.kind === "text") return request.images === 0 && request.audio === 0;
  return request.images >= workflow.minimumImages && request.images <= workflow.maximumImages
    && request.audio >= workflow.minimumAudio && request.audio <= workflow.maximumAudio
    && request.duration <= workflow.maximumDuration;
}

function byId(id: string): AutoDlH3Workflow | undefined { return autoDlH3Workflows.find((workflow) => workflow.id === id); }

export function selectAutoDlH3Workflow(request: AutoDlH3RequestShape, configuredId?: string): AutoDlH3Workflow {
  assert(request.referenceVideo === 0,
    "AutoDL's current public H3 catalogue has no reference-video workflow; provide image and audio references instead");
  if (request.firstFrame || request.lastFrame) {
    assert(request.firstFrame && request.lastFrame, "AutoDL H3 frame workflows require both a firstFrame and lastFrame");
  }
  if (configuredId !== undefined) {
    const workflow = byId(configuredId);
    assert(workflow !== undefined, `AutoDL H3 workflow ${configuredId} is not in the configured public catalogue`);
    assert(compatible(workflow, request), `AutoDL H3 workflow ${configuredId} does not accept this request's reference media or duration`);
    return workflow;
  }
  const preferred = request.firstFrame ? "minimax_h3_b99_002"
    : request.images > 0 && request.audio > 0 && request.images <= 6 ? "minimax_h3_z0903"
    : request.images > 0 && request.audio > 0 ? "minimax_h3_image_audio_to_video_v2_15s"
    : request.images > 0 && request.images <= 6 ? "minimax_h3_z0902"
    : request.images > 0 ? "minimax_h3_lightx2v_v5_15s"
    : "minimax_h3_z0901";
  const workflow = byId(preferred)!;
  assert(compatible(workflow, request), `AutoDL H3 has no public workflow for this request's reference media or duration`);
  return workflow;
}

export function autoDlH3Resolution(workflow: AutoDlH3Workflow, aspectRatio: unknown): string {
  const ratio = aspectRatio === undefined ? "9:16" : aspectRatio;
  assert(ratio === "9:16" || ratio === "16:9" || ratio === "1:1", `AutoDL H3 does not support aspect ratio ${String(ratio)}`);
  const resolution = workflow.resolutions[ratio];
  assert(resolution !== undefined, `AutoDL H3 workflow ${workflow.id} does not support aspect ratio ${ratio}`);
  return resolution;
}
