import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import { Contract, type ContractT } from "../artifacts/contract.ts";

export async function writeContractYaml(contract: ContractT, path: string): Promise<void> {
  const validated = Contract.parse(contract);
  const yaml = YAML.stringify(validated);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, yaml, "utf8");
  await rename(tmp, path);
}

export async function readContractYaml(path: string): Promise<ContractT> {
  const raw = await readFile(path, "utf8");
  const obj = YAML.parse(raw);
  return Contract.parse(obj);
}
