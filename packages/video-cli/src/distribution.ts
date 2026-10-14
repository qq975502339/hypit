import type { CliDistribution } from "@hypit/cli";
import {
  doctorProjectBuildResultRepository,
  openLocalRuntimeHost,
  openProjectBuildResultRepository,
} from "@hypit/runtime-local";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createVideoCompiler,
} from "./compiler.js";

// The Distribution root is the replaceable Hypit tool checkout, not this
// package's source directory and never the author's project.
const packageRoot = resolve(import.meta.dirname, "../../..");
const defaultBuildResultRepository = {
  use: "@hypit/build-result-fs",
  config: { path: ".hypit/results" },
} as const;

/** Official video authoring assembly for the generic CLI engine. */
export const videoCliDistribution: CliDistribution = {
  packageRoot,
  bootstrapPackages: [],
  initialRuntimeProfile: {
    format: "hypit.runtime-local@1",
    dataRoot: ".hypit/runtimes/local",
    // The starter selects the portable Store, so the Profile it writes is openable and writable on
    // Linux as well: macOS and Windows keep the platform locker, and a Linux host uses an
    // owner-private file. `os` and `file` stay selectable by name for one explicit backend.
    credentials: {
      platform: { use: "@hypit/credential-store-platform" },
    },
    endpoints: {
      "local-ai.default": {
        use: "@hypit/provider-local-ai",
        pool: "local-ai.default",
        config: {
          autodlToken: { store: "platform", key: "autodl.comfyui-h3" },
          dashscopeApiKey: { store: "platform", key: "dashscope.qwen3-tts" },
        },
      },
      "hypihub.default": {
        use: "@hypit/provider-hypihub",
        config: {
          baseUrl: "https://hypit.ai",
          apiKey: { store: "platform", key: "hypihub.oauth" },
        },
      },
      "media.local": {
        use: "@hypit/provider-media-local",
      },
      "hyperframes.local": {
        use: "@hypit/provider-hyperframes-local",
      },
    },
    bindings: {
      "@hypit/gpt-image@1#gpt-image-2": "local-ai.default",
      "@hypit/minimax-h3@1#minimax-h3": "local-ai.default",
      "@hypit/mimo-speech@1#mimo-v2.5-tts-voicedesign": "local-ai.default",
      "@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone": "local-ai.default",
    },
  },
  createCompiler: createVideoCompiler,
  discoverSourcePackages: async (path, options) => {
    const { discoverVideoSourcePackages } = await import("./package-selection.js");
    return await discoverVideoSourcePackages(path, options);
  },
  openRuntimeHost: async (path, options) => await openLocalRuntimeHost(path, {
    packageRoot: options.packageRoot,
    ...(options.distributionPackageRoot === undefined
      ? {}
      : { distributionPackageRoot: options.distributionPackageRoot }),
    workerLaunch: {
      command: process.execPath,
      // The loaded Distribution owns its Worker entry and TypeScript/package resolution.
      args: [fileURLToPath(new URL("../../../bin/hypit.mjs", import.meta.url))],
    },
  }),
  openProjectResults: async (projectRoot, options) => {
    const opened = await openProjectBuildResultRepository(projectRoot, {
      ...options,
      distributionPackageRoot: options.distributionPackageRoot ?? packageRoot,
      defaultSelection: defaultBuildResultRepository,
    });
    return {
      location: opened.location,
      repository: opened.repository,
      close: async () => await opened.close?.(),
    };
  },
  diagnoseProjectResults: async (projectRoot, options) =>
    await doctorProjectBuildResultRepository(projectRoot, {
      ...options,
      distributionPackageRoot: options.distributionPackageRoot ?? packageRoot,
      defaultSelection: defaultBuildResultRepository,
    }),
};
