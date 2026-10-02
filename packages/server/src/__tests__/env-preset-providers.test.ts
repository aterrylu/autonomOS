import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * REGRESSION GUARD for #496 (ADR-144): the V13 allowlist omitted keys real
 * Kimi presets for Claude Code set (ANTHROPIC_DEFAULT_FABLE_MODEL,
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW, CLAUDE_CODE_EFFORT_LEVEL), which would
 * have refused every such agent after an upgrade. Each fixture below is the
 * exact variable set a provider's OFFICIAL Claude Code (or Codex / Gemini)
 * setup guide tells users to set, with placeholder values. Every one must be
 * accepted as a preset and inject in full. Taking any of its keys off the
 * allowlist turns this RED and names the provider.
 *
 * To add a provider: copy its guide's variables here, cite the URL.
 */

const TEST_DIR = join(tmpdir(), `autonomos-provider-presets-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;
const {
  applyPresetToEnv,
  createEnvPreset,
  isAllowedPresetKey,
  NEVER_PRESET_KEYS,
  PRESET_ALLOWED_ENV_KEYS,
} = await import("../envPresets.js");
const { RESERVED_ENV_KEYS } = await import("../providers/shared.js");

before(() => mkdirSync(TEST_DIR, { recursive: true }));
after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

const KEY = "<key>";
type Fixture = { source: string; env: Record<string, string> };

const PROVIDER_PRESETS: Record<string, Fixture> = {
  "kimi-platform-intl": {
    source: "https://platform.kimi.ai/docs/guide/claude-code-kimi.md",
    env: {
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: "kimi-k3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.7-code",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k3[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k3[1m]",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    },
  },
  "kimi-platform-cn": {
    source: "https://platform.moonshot.cn/docs/guide/claude-code-kimi.md",
    env: {
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: "kimi-k3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.7-code",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k3[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k3[1m]",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    },
  },
  "kimi-code": {
    source:
      "https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html",
    env: {
      ANTHROPIC_BASE_URL: "https://api.kimi.ai/coding/",
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "k3[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "k3[1m]",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1048576",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
    },
  },
  "zai-glm": {
    source: "https://docs.z.ai/devpack/tool/claude",
    env: {
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      API_TIMEOUT_MS: "3000000",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  },
  "bigmodel-glm-cn": {
    source: "https://docs.bigmodel.cn/cn/coding-plan/tool/claude",
    env: {
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      API_TIMEOUT_MS: "3000000",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "<model>",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "<model>",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "<model>",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  },
  deepseek: {
    source:
      "https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code",
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
    },
  },
  openrouter: {
    source:
      "https://openrouter.ai/docs/guides/guides/claude-code-integration.md",
    env: {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: KEY,
      // Deliberately empty in the guide: an empty value must be accepted.
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "~anthropic/claude-fable-latest[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "~anthropic/claude-opus-latest[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "~anthropic/claude-sonnet-latest[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "~anthropic/claude-haiku-latest",
      CLAUDE_CODE_SUBAGENT_MODEL: "~anthropic/claude-opus-latest[1m]",
      CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1",
    },
  },
  litellm: {
    source: "https://docs.litellm.ai/docs/proxy/client_setup/claude_code",
    env: {
      ANTHROPIC_BASE_URL: "http://localhost:4000",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: "claude-sonnet-5",
    },
  },
  "litellm-non-anthropic": {
    source:
      "https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models",
    env: {
      ANTHROPIC_BASE_URL: "http://0.0.0.0:4000",
      ANTHROPIC_AUTH_TOKEN: KEY,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      ENABLE_TOOL_SEARCH: "true",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "<model>",
    },
  },
  "alibaba-dashscope": {
    source: "https://help.aliyun.com/en/model-studio/claude-code",
    env: {
      ANTHROPIC_BASE_URL:
        "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.6-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3.7-plus",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    },
  },
  minimax: {
    source: "https://platform.minimax.io/docs/token-plan/claude-code.md",
    env: {
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      ANTHROPIC_MODEL: "MiniMax-M3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M3[1m]",
    },
  },
  "vercel-ai-gateway": {
    source: "https://vercel.com/docs/ai-gateway/coding-agents/claude-code.md",
    env: {
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    },
  },
  "vercel-ai-gateway-header-auth": {
    source: "https://vercel.com/docs/ai-gateway/coding-agents/claude-code.md",
    env: {
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code",
      ANTHROPIC_CUSTOM_HEADERS: "x-ai-gateway-api-key: Bearer <key>",
    },
  },
  requesty: {
    source: "https://docs.requesty.ai/integrations/claude-code.md",
    env: {
      ANTHROPIC_BASE_URL: "https://router.requesty.ai",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: "anthropic/claude-fable-5",
    },
  },
  "cloudflare-ai-gateway": {
    source:
      "https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/",
    env: {
      ANTHROPIC_BASE_URL:
        "https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic",
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_CUSTOM_HEADERS: "cf-aig-authorization: Bearer <cf-token>",
    },
  },
  "claude-code-bedrock": {
    source: "https://code.claude.com/docs/en/amazon-bedrock",
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: KEY,
      ANTHROPIC_MODEL: "<model>",
      ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: "us-west-2",
    },
  },
  "claude-code-vertex": {
    source: "https://code.claude.com/docs/en/google-vertex-ai",
    env: {
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "us-east5",
      ANTHROPIC_VERTEX_PROJECT_ID: "<project>",
      VERTEX_REGION_CLAUDE_3_5_HAIKU: "us-central1",
    },
  },
  "claude-code-foundry": {
    source: "https://code.claude.com/docs/en/microsoft-foundry",
    env: {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "<resource>",
      ANTHROPIC_FOUNDRY_API_KEY: KEY,
    },
  },
  codex: {
    source: "Codex docs: config-file/environment-variables, auth",
    env: { CODEX_API_KEY: KEY, OPENAI_API_KEY: KEY },
  },
  gemini: {
    source:
      "https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md",
    env: {
      GEMINI_API_KEY: KEY,
      GEMINI_MODEL: "<model>",
      GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com",
    },
  },
  "gemini-vertex": {
    source:
      "https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx",
    env: {
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "<project>",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_APPLICATION_CREDENTIALS: "/path/to/sa.json",
    },
  },
};

describe("every documented provider preset is accepted and injects in full (ADR-144)", () => {
  for (const [provider, { source, env }] of Object.entries(PROVIDER_PRESETS)) {
    it(provider, () => {
      const offList = Object.keys(env).filter((k) => !isAllowedPresetKey(k));
      assert.deepEqual(
        offList,
        [],
        `${provider}'s documented setup (${source}) needs ${offList.join(", ")}, which the allowlist doesn't have: its presets would refuse to spawn`,
      );
      createEnvPreset({ name: `p-${provider}`, env }, 1);
      const target: Record<string, string> = {};
      applyPresetToEnv(target, `p-${provider}`);
      assert.deepEqual(target, env, `${provider} didn't inject in full`);
    });
  }
});

describe("the allowlist's own consistency", () => {
  it("allows no control-plane key and no key that runs code", () => {
    const bad = [...PRESET_ALLOWED_ENV_KEYS].filter(
      (k) => RESERVED_ENV_KEYS.has(k) || NEVER_PRESET_KEYS.has(k),
    );
    assert.deepEqual(bad, []);
  });

  it("the audit's code-execution keys stay refused", () => {
    for (const k of [
      "BASH_ENV",
      "SHELL",
      "CLAUDE_CODE_SHELL_PREFIX",
      "CLAUDE_CODE_PROCESS_WRAPPER",
      "CLAUDE_ENV_FILE",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "GEMINI_CLI_HOME",
      "GEMINI_SANDBOX",
      "GIT_SSH_COMMAND",
      "NODE_OPTIONS",
      "AWS_CONFIG_FILE",
    ]) {
      assert.equal(isAllowedPresetKey(k), false, k);
    }
  });
});
