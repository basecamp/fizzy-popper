import { describe, it, expect, vi, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { resolveFizzyApiUrl } from "../src/setup.js"

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}))

const mockedExecFileSync = vi.mocked(execFileSync)

describe("resolveFizzyApiUrl", () => {
  afterEach(() => {
    delete process.env.FIZZY_API_URL
    vi.clearAllMocks()
  })

  it("uses FIZZY_API_URL when set", () => {
    process.env.FIZZY_API_URL = "https://fizzy.example.test/"

    expect(resolveFizzyApiUrl()).toBe("https://fizzy.example.test")
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })

  it("uses the effective api_url from the Fizzy CLI", () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({ ok: true, data: { api_url: "https://fizzy.joshyorko.com" } }),
    )

    expect(resolveFizzyApiUrl()).toBe("https://fizzy.joshyorko.com")
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "fizzy",
      ["config", "show", "--json"],
      expect.objectContaining({ encoding: "utf-8" }),
    )
  })

  it("falls back to hosted Fizzy when CLI config cannot be read", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("missing fizzy cli")
    })

    expect(resolveFizzyApiUrl()).toBe("https://app.fizzy.do")
  })
})
