import { mintRunScopeMarker } from "@claudexor/core";
import { ProjectConfig, type ActiveTaskContract } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { gateSpecsFromContract, resolveContractGates } from "./contract-gates.js";

describe("contract gate resolution", () => {
  it("omits versioned project gates from readonly contracts", () => {
    const command = {
      program: "sh",
      args: ["-c", "printf ran > gate-ran.txt"],
      envAllowlist: [],
    };
    const config = ProjectConfig.parse({ tests: { commands: [command] } });

    expect(
      resolveContractGates({
        repoRoot: "/project",
        effectiveAccess: "readonly",
        config,
        trustGrants: [],
        operatorCommands: [],
        projectCommands: config.tests.commands,
      }),
    ).toEqual({ commands: [], autoProtectedPaths: [] });
  });
});

describe("run gate specs", () => {
  it("carry the owning run's scope marker, and nothing when the run has none", () => {
    const contract = {
      tests: {
        commands: [{ id: "unit", program: "sh", args: ["-c", "true"], envAllowlist: [] }],
      },
      repo: { root: "/project" },
      access: { effective_profile: "workspace_write" },
    } as unknown as ActiveTaskContract;
    const marker = mintRunScopeMarker();
    expect(gateSpecsFromContract(contract, marker)[0]?.env).toEqual({ [marker]: "1" });
    expect(gateSpecsFromContract(contract)[0]).not.toHaveProperty("env");
  });
});
