import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  evaluateAcceptance,
  type AcceptanceReport,
  type AcceptanceSampleSet,
  type AcceptanceSuite
} from "../src/evaluation/acceptance";

const args = process.argv.slice(2);
void main();

async function main(): Promise<void> {
  const inputPath = option(args, "--input");
  const suitePath = resolve(option(args, "--suite") ?? "acceptance/suite-v1.json");
  const outputPath = resolve(option(args, "--output") ?? "acceptance-report.json");
  if (!inputPath) {
    console.error("缺少 --input。示例：npm run acceptance -- --input .llm-wiki-acceptance/observations.json");
    process.exitCode = 2;
    return;
  }
  const suite = await readJson<AcceptanceSuite>(suitePath);
  const samples = await readJson<AcceptanceSampleSet>(resolve(inputPath));
  const report = evaluateAcceptance(suite, samples);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printReport(report, outputPath);
  if (!report.passed) process.exitCode = 1;
}

function option(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function printReport(report: AcceptanceReport, path: string): void {
  console.log(`T-Wiki acceptance ${report.suiteId}: ${report.passed ? "PASS" : "FAIL"}`);
  for (const scenario of report.scenarios) {
    console.log(`${scenario.passed ? "PASS" : "FAIL"} ${scenario.id} (${scenario.sampleCount}/${scenario.minimumSamples})`);
    for (const metric of scenario.metrics) {
      const actual = metric.value === undefined ? "missing" : Number(metric.value.toFixed(4));
      console.log(`  ${metric.metric}.${metric.aggregation}=${actual} ${metric.operator} ${metric.target}`);
    }
  }
  console.log(`Report: ${path}`);
}
