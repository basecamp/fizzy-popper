import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { stringify as stringifyYaml } from "yaml"
import { loadConfig, saveConfig, configExists, configPath, configDir } from "../src/config.js"

describe("config", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fizzy-popper-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeConfig(data: Record<string, unknown>): void {
    const dir = join(tempDir, ".fizzy-popper")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "config.yml"), stringifyYaml(data), "utf-8")
  }

  describe("configPath", () => {
    it("returns path under .fizzy-popper/config.yml", () => {
      const path = configPath(tempDir)
      expect(path).toBe(join(tempDir, ".fizzy-popper", "config.yml"))
    })
  })

  describe("configDir", () => {
    it("returns .fizzy-popper directory", () => {
      const dir = configDir(tempDir)
      expect(dir).toBe(join(tempDir, ".fizzy-popper"))
    })
  })

  describe("configExists", () => {
    it("returns false when no config", () => {
      expect(configExists(tempDir)).toBe(false)
    })

    it("returns true when config exists", () => {
      writeConfig({ fizzy: { token: "t", account: "a" } })
      expect(configExists(tempDir)).toBe(true)
    })
  })

  describe("loadConfig", () => {
    it("throws when config file is missing", () => {
      expect(() => loadConfig(tempDir)).toThrow("Config not found")
    })

    it("loads a valid config with all fields", () => {
      writeConfig({
        fizzy: { token: "fz_test", account: "123", api_url: "https://app.fizzy.do" },
        boards: ["board-1"],
        webhook: { port: 4567 },
        agent: { max_concurrent: 3, timeout: 60000, default_backend: "claude" },
        polling: { interval: 15000 },
      })

      const config = loadConfig(tempDir)
      expect(config.fizzy.token).toBe("fz_test")
      expect(config.fizzy.account).toBe("123")
      expect(config.agent.max_concurrent).toBe(3)
      expect(config.polling.interval).toBe(15000)
    })

    it("applies defaults for optional fields", () => {
      writeConfig({
        fizzy: { token: "fz_test", account: "123" },
      })

      const config = loadConfig(tempDir)
      expect(config.fizzy.api_url).toBe("https://app.fizzy.do")
      expect(config.boards).toBe("all")
      expect(config.webhook.port).toBe(4567)
      expect(config.agent.max_concurrent).toBe(5)
      expect(config.agent.timeout).toBe(300_000)
      expect(config.agent.default_backend).toBe("claude")
      expect(config.polling.interval).toBe(30_000)
    })

    it("resolves $ENV_VAR references", () => {
      process.env.TEST_FIZZY_TOKEN = "fz_from_env"
      writeConfig({
        fizzy: { token: "$TEST_FIZZY_TOKEN", account: "123" },
      })

      const config = loadConfig(tempDir)
      expect(config.fizzy.token).toBe("fz_from_env")

      delete process.env.TEST_FIZZY_TOKEN
    })

    it("keeps $VAR literal when env var is unset", () => {
      delete process.env.NONEXISTENT_VAR_12345
      writeConfig({
        fizzy: { token: "$NONEXISTENT_VAR_12345", account: "123" },
      })

      const config = loadConfig(tempDir)
      expect(config.fizzy.token).toBe("$NONEXISTENT_VAR_12345")
    })

    it("resolves env vars in arrays", () => {
      process.env.TEST_BOARD_ID = "board-from-env"
      writeConfig({
        fizzy: { token: "fz_t", account: "a" },
        boards: ["$TEST_BOARD_ID", "board-2"],
      })

      const config = loadConfig(tempDir)
      expect(config.boards).toEqual(["board-from-env", "board-2"])

      delete process.env.TEST_BOARD_ID
    })

    it("resolves env vars in nested objects", () => {
      process.env.TEST_ANTHROPIC_KEY = "sk-ant-test"
      writeConfig({
        fizzy: { token: "fz_t", account: "a" },
        backends: { anthropic: { api_key: "$TEST_ANTHROPIC_KEY" } },
      })

      const config = loadConfig(tempDir)
      expect(config.backends.anthropic?.api_key).toBe("sk-ant-test")

      delete process.env.TEST_ANTHROPIC_KEY
    })

    it("throws on invalid config (missing fizzy)", () => {
      writeConfig({ boards: ["board-1"] })
      expect(() => loadConfig(tempDir)).toThrow()
    })

    it("throws a friendly error on invalid YAML", () => {
      const dir = join(tempDir, ".fizzy-popper")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "config.yml"), "fizzy:\n  token: \"unterminated", "utf-8")
      expect(() => loadConfig(tempDir)).toThrow(/Failed to parse/)
    })

    it("accepts boards as 'all' string", () => {
      writeConfig({
        fizzy: { token: "fz_t", account: "a" },
        boards: "all",
      })

      const config = loadConfig(tempDir)
      expect(config.boards).toBe("all")
    })

    it("accepts backend configs", () => {
      writeConfig({
        fizzy: { token: "fz_t", account: "a" },
        backends: {
          claude: { model: "opus" },
          command: { run: "my-script {prompt_file}" },
        },
      })

      const config = loadConfig(tempDir)
      expect(config.backends.claude?.model).toBe("opus")
      expect(config.backends.command?.run).toBe("my-script {prompt_file}")
    })
  })

  describe("saveConfig", () => {
    it("creates .fizzy-popper directory and writes config", () => {
      const config = {
        fizzy: { token: "fz_saved", account: "456" },
        boards: ["board-1"],
      }

      const path = saveConfig(config, tempDir)

      expect(existsSync(path)).toBe(true)
      expect(path).toBe(join(tempDir, ".fizzy-popper", "config.yml"))

      // Should be loadable
      const loaded = loadConfig(tempDir)
      expect(loaded.fizzy.token).toBe("fz_saved")
      expect(loaded.fizzy.account).toBe("456")
    })

    it("overwrites existing config", () => {
      writeConfig({ fizzy: { token: "old", account: "a" } })
      saveConfig({ fizzy: { token: "new", account: "b" } }, tempDir)

      const loaded = loadConfig(tempDir)
      expect(loaded.fizzy.token).toBe("new")
      expect(loaded.fizzy.account).toBe("b")
    })
  })
})
