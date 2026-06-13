/**
 * After Allure generate: read each test's "All Applied Jobs (CSV)" attachment
 * and inject Overview description + job parameters (visible in Overview tab).
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildOverviewFromJobs, parseAppliedJobsCsv } from '../src/overview-from-csv';

const projectDir = path.join(__dirname, '..');
const reportDir = path.join(projectDir, 'allure-report');
const testCasesDir = path.join(reportDir, 'data', 'test-cases');
const attachmentsDir = path.join(reportDir, 'data', 'attachments');

if (!fs.existsSync(testCasesDir)) {
  console.error('No allure-report/data/test-cases — run allure generate first.');
  process.exit(1);
}

let enriched = 0;

for (const file of fs.readdirSync(testCasesDir).filter((f) => f.endsWith('.json'))) {
  const filePath = path.join(testCasesDir, file);
  const tc = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;

  const stageAttachments: { name?: string; source?: string; uid?: string; type?: string; size?: number }[] =
    tc.testStage?.attachments ?? tc.attachments ?? [];
  const csvAtt = stageAttachments.find((a) => a.name === 'All Applied Jobs (CSV)');
  if (!csvAtt?.source) continue;

  const csvPath = path.join(attachmentsDir, csvAtt.source);
  if (!fs.existsSync(csvPath)) continue;

  const csv = fs.readFileSync(csvPath, 'utf8');
  const jobs = parseAppliedJobsCsv(csv);
  if (jobs.length === 0) continue;

  const totalParam = (tc.parameters as { name: string; value: string }[] | undefined)?.find(
    (p) => p.name === 'totalApplied',
  );
  const totalApplied = totalParam ? Number(totalParam.value) : jobs.length;

  const overview = buildOverviewFromJobs(jobs, totalApplied);

  tc.description = overview.description;
  tc.descriptionHtml = overview.descriptionHtml;
  if (tc.testStage) {
    tc.testStage.description = overview.description;
    tc.testStage.descriptionHtml = overview.descriptionHtml;
  }

  const keepParams = ((tc.parameters as { name: string; value: string }[]) ?? []).filter(
    (p) => !p.name.startsWith('Job ') && p.name !== 'totalJobsApplied' && p.name !== 'jobsListedInCsv',
  );
  tc.parameters = [...keepParams, ...overview.parameters];
  tc.parameterValues = tc.parameters.map((p: { value: string }) => p.value);

  // Write standalone HTML attachment for inline preview
  const htmlName = `${path.basename(file, '.json')}-overview.html`;
  const htmlPath = path.join(attachmentsDir, htmlName);
  fs.writeFileSync(
    htmlPath,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Applied Jobs</title></head><body>${overview.descriptionHtml}</body></html>`,
    'utf8',
  );

  const htmlUid = htmlName.replace('.html', '');
  const htmlAttachment = {
    uid: htmlUid,
    name: 'Applied Jobs Overview (HTML)',
    source: htmlName,
    type: 'text/html',
    size: fs.statSync(htmlPath).size,
  };

  const existing = stageAttachments.filter((a) => a.name !== 'Applied Jobs Overview (HTML)');
  if (tc.testStage) {
    tc.testStage.attachments = [htmlAttachment, ...existing];
  } else {
    tc.attachments = [htmlAttachment, ...existing];
  }

  fs.writeFileSync(filePath, JSON.stringify(tc), 'utf8');
  enriched++;
  console.log(`Enriched Overview from CSV: ${tc.name}`);
}

console.log(`Allure Overview enriched for ${enriched} test case(s).`);
