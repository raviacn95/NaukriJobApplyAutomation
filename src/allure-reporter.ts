import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { buildOverviewFromJobs, escapeHtml, shortJd, type CsvJobRow } from './overview-from-csv';
export interface AppliedJobRecord {
  title: string;
  company: string;
  location: string;
  experience: string;
  salary: string;
  jd: string;
  jobUrl: string;
  loop: number;
  batchIndex: number;
  appliedAt: string;
  status: 'applied' | 'blocked' | 'selected';
}

interface AllureStep {
  name: string;
  status: string;
  stage: string;
  start: number;
  stop: number;
  uuid: string;
  attachments: { name: string; source: string; type: string }[];
  parameters: { name: string; value: string }[];
  steps: AllureStep[];
  descriptionHtml?: string;
}

const RESULTS_DIR = path.join(__dirname, '..', 'allure-results');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const HISTORY_ARCHIVE_DIR = path.join(REPORTS_DIR, 'allure-history');

export class NaukriAllureReporter {
  private readonly runUuid = randomUUID();
  private readonly runStart = Date.now();
  private loopSteps: AllureStep[] = [];
  private allJobs: AppliedJobRecord[] = [];
  private readonly parameters: { name: string; value: string }[] = [];
  private status: 'passed' | 'failed' | 'broken' = 'passed';
  private statusDetails: { message?: string; trace?: string } = {};
  private finished = false;
  private summaryAttachmentIds: string[] = [];
  private overviewHtmlAttachmentId = '';

  constructor(meta: { shard: string; totalLoops: number; jobsPerLoop: number }) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.mkdirSync(HISTORY_ARCHIVE_DIR, { recursive: true });
    this.parameters.push(
      { name: 'shard', value: meta.shard },
      { name: 'totalLoops', value: String(meta.totalLoops) },
      { name: 'jobsPerLoop', value: String(meta.jobsPerLoop) },
      { name: 'runStartedAt', value: new Date(this.runStart).toISOString() },
    );
    this.writeResult();
  }

  get runId(): string {
    return this.runUuid;
  }

  private writeAttachment(content: string, ext: 'json' | 'txt' | 'csv' | 'html'): string {
    const id = randomUUID();
    fs.writeFileSync(path.join(RESULTS_DIR, `${id}-attachment.${ext}`), content, 'utf8');
    return id;
  }

  recordLoop(loop: number, totalLoops: number, applied: number, rejected403: boolean, jobs: AppliedJobRecord[]) {
    const stepStart = Date.now();
    const stepUuid = randomUUID();

    const jobsJsonId = this.writeAttachment(JSON.stringify(jobs, null, 2), 'json');
    const jdMarkdown = jobs
      .map(
        (j, idx) =>
          `## ${idx + 1}. ${j.title || 'Job ' + (idx + 1)}\n` +
          `- **Company:** ${j.company || 'N/A'}\n` +
          `- **Location:** ${j.location || 'N/A'}\n` +
          `- **Experience:** ${j.experience || 'N/A'}\n` +
          `- **Salary:** ${j.salary || 'N/A'}\n` +
          `- **URL:** ${j.jobUrl || 'N/A'}\n\n` +
          `${j.jd || 'No description captured.'}\n`,
      )
      .join('\n---\n\n');
    const jdId = this.writeAttachment(jdMarkdown || 'No jobs in this loop.', 'txt');

    this.allJobs.push(...jobs);
    if (rejected403) this.status = 'broken';

    let stepStatus = 'passed';
    if (rejected403) stepStatus = 'broken';
    else if (applied === 0) stepStatus = 'skipped';

    const jobSteps: AllureStep[] = jobs.map((j, idx) => ({
      name: `${idx + 1}. ${j.title || 'Unknown role'} @ ${j.company || 'Unknown company'}`,
      status: stepStatus,
      stage: 'finished',
      start: stepStart,
      stop: Date.now(),
      uuid: randomUUID(),
      attachments: [],
      parameters: [
        { name: 'loop', value: String(loop) },
        { name: 'company', value: j.company || 'N/A' },
        { name: 'location', value: j.location || 'N/A' },
        { name: 'salary', value: j.salary || 'N/A' },
        { name: 'experience', value: j.experience || 'N/A' },
        { name: 'jobUrl', value: j.jobUrl || 'N/A' },
        { name: 'shortJd', value: shortJd(j.jd, 200) },
      ],
      steps: [],
      descriptionHtml: buildJobRowHtml(j, idx + 1),
    }));

    this.loopSteps.push({
      name: `Loop ${loop}/${totalLoops} — ${applied} job(s) applied${rejected403 ? ' [403 blocked]' : ''}`,
      status: stepStatus,
      stage: 'finished',
      start: stepStart,
      stop: Date.now(),
      uuid: stepUuid,
      attachments: [
        { name: 'Applied Jobs (JSON)', source: `${jobsJsonId}-attachment.json`, type: 'application/json' },
        { name: 'Job Descriptions', source: `${jdId}-attachment.txt`, type: 'text/plain' },
      ],
      parameters: [
        { name: 'loop', value: String(loop) },
        { name: 'appliedCount', value: String(applied) },
        { name: 'rejected403', value: String(rejected403) },
        { name: 'jobsInLoop', value: jobs.map((j) => `${j.title || 'Unknown'} @ ${j.company || 'Unknown'}`).join(' | ') || 'None' },
      ],
      steps: jobSteps,
      descriptionHtml: buildLoopOverviewHtml(loop, jobs),
    });

    this.updateLiveHistory();
    this.writeResult();
  }

  finishRun(totalApplied: number, fatalError?: string) {
    this.finished = true;
    if (fatalError) {
      this.status = 'failed';
      this.statusDetails = { message: fatalError };
    }

    this.parameters.push(
      { name: 'totalApplied', value: String(totalApplied) },
      { name: 'totalJobsRecorded', value: String(this.allJobs.length) },
      { name: 'runFinishedAt', value: new Date().toISOString() },
    );

    const summaryId = this.writeAttachment(
      JSON.stringify({ totalApplied, totalJobs: this.allJobs.length, jobs: this.allJobs }, null, 2),
      'json',
    );
    const csvHeader = 'loop,batchIndex,title,company,location,experience,salary,jobUrl,appliedAt,status,jd';
    const csvRows = this.allJobs.map((j) =>
      [
        j.loop,
        j.batchIndex,
        csvEscape(j.title),
        csvEscape(j.company),
        csvEscape(j.location),
        csvEscape(j.experience),
        csvEscape(j.salary),
        csvEscape(j.jobUrl),
        j.appliedAt,
        j.status,
        csvEscape(j.jd),
      ].join(','),
    );
    const csvId = this.writeAttachment([csvHeader, ...csvRows].join('\n'), 'csv');

    const overview = buildOverviewFromJobs(toCsvRows(this.allJobs), totalApplied);
    this.overviewHtmlAttachmentId = this.writeAttachment(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Applied Jobs</title></head><body>${overview.descriptionHtml}</body></html>`,
      'html',
    );
    this.syncOverviewParameters(overview.parameters);

    this.summaryAttachmentIds = [
      `${this.overviewHtmlAttachmentId}-attachment.html`,
      `${summaryId}-attachment.json`,
      `${csvId}-attachment.csv`,
    ];

    this.updateLiveHistory(true);
    this.writeResult();
    this.archiveRunToHistory();
  }

  private archiveRunToHistory() {
    const runDir = path.join(HISTORY_ARCHIVE_DIR, this.runUuid);
    fs.mkdirSync(runDir, { recursive: true });

    const resultFile = `${this.runUuid}-result.json`;
    const resultPath = path.join(RESULTS_DIR, resultFile);
    if (fs.existsSync(resultPath)) {
      fs.copyFileSync(resultPath, path.join(runDir, resultFile));
    }

    const attachmentSources = new Set<string>();
    for (const step of this.loopSteps) {
      for (const att of step.attachments) attachmentSources.add(att.source);
    }
    for (const src of this.summaryAttachmentIds) attachmentSources.add(src);

    for (const src of attachmentSources) {
      const srcPath = path.join(RESULTS_DIR, src);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(runDir, src));
      }
    }

    fs.writeFileSync(
      path.join(runDir, 'manifest.json'),
      JSON.stringify(
        {
          runUuid: this.runUuid,
          startedAt: new Date(this.runStart).toISOString(),
          finishedAt: new Date().toISOString(),
          totalJobs: this.allJobs.length,
          totalApplied: this.allJobs.filter((j) => j.status === 'applied').length,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  private syncOverviewParameters(jobParams: { name: string; value: string }[]) {
    const keep = this.parameters.filter(
      (p) => !p.name.startsWith('Job ') && p.name !== 'totalJobsApplied' && p.name !== 'jobsListedInCsv',
    );
    this.parameters.splice(0, this.parameters.length, ...keep, ...jobParams);
  }

  private writeResult() {
    const overview = buildOverviewFromJobs(
      toCsvRows(this.allJobs),
      this.finished ? Number(this.parameters.find((p) => p.name === 'totalApplied')?.value) : undefined,
    );
    if (this.allJobs.length > 0) {
      this.syncOverviewParameters(overview.parameters);
    }

    const attachmentNames = ['Applied Jobs Overview (HTML)', 'Full Run Summary (JSON)', 'All Applied Jobs (CSV)'];
    const attachmentTypes = ['text/html', 'application/json', 'text/csv'];
    const attachments = this.summaryAttachmentIds.map((source, i) => ({
      name: attachmentNames[i] ?? `Attachment ${i + 1}`,
      source,
      type: attachmentTypes[i] ?? 'text/plain',
    }));

    const result = {
      uuid: this.runUuid,
      name: `Naukri Auto Apply — ${new Date(this.runStart).toLocaleString()}`,
      historyId: 'naukri-auto-apply-run',
      fullName: 'naukri-apply.spec.ts',
      status: this.status,
      statusDetails: this.statusDetails,
      stage: this.finished ? 'finished' : 'running',
      start: this.runStart,
      stop: this.finished ? Date.now() : undefined,
      description: overview.description,
      descriptionHtml: overview.descriptionHtml,
      steps: this.loopSteps,
      attachments,
      parameters: this.parameters,
      labels: [
        { name: 'framework', value: 'playwright' },
        { name: 'language', value: 'typescript' },
        { name: 'suite', value: 'Naukri Job Apply' },
        { name: 'epic', value: 'Naukri Automation' },
        { name: 'feature', value: 'Recommended Jobs Apply' },
      ],
      links: [],
    };

    fs.writeFileSync(path.join(RESULTS_DIR, `${this.runUuid}-result.json`), JSON.stringify(result, null, 2), 'utf8');
  }

  private updateLiveHistory(runComplete = false) {
    const historyPath = path.join(REPORTS_DIR, 'applied-jobs-live.json');
    let history: {
      lastUpdated: string;
      totalRuns: number;
      totalJobsApplied: number;
      runs: {
        runId: string;
        startedAt: string;
        finished: boolean;
        totalApplied: number;
        jobs: AppliedJobRecord[];
      }[];
    };

    if (fs.existsSync(historyPath)) {
      try {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      } catch {
        history = { lastUpdated: '', totalRuns: 0, totalJobsApplied: 0, runs: [] };
      }
    } else {
      history = { lastUpdated: '', totalRuns: 0, totalJobsApplied: 0, runs: [] };
    }

    const existingRun = history.runs.find((r) => r.runId === this.runUuid);
    const runEntry = {
      runId: this.runUuid,
      startedAt: new Date(this.runStart).toISOString(),
      finished: runComplete,
      totalApplied: this.allJobs.filter((j) => j.status === 'applied').length,
      jobs: this.allJobs,
    };

    if (existingRun) Object.assign(existingRun, runEntry);
    else {
      history.runs.unshift(runEntry);
      if (runComplete) history.totalRuns += 1;
    }

    history.lastUpdated = new Date().toISOString();
    history.totalJobsApplied = history.runs.reduce((sum, r) => sum + r.totalApplied, 0);
    history.runs = history.runs.slice(0, 100);

    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
  }
}

function csvEscape(value: string): string {
  const v = String(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ');
  return `"${v}"`;
}

function toCsvRows(jobs: AppliedJobRecord[]): CsvJobRow[] {
  return jobs.map((j) => ({
    loop: String(j.loop),
    batchIndex: String(j.batchIndex),
    title: j.title,
    company: j.company,
    location: j.location,
    experience: j.experience,
    salary: j.salary,
    jobUrl: j.jobUrl,
    appliedAt: j.appliedAt,
    status: j.status,
    jd: j.jd,
  }));
}

function buildJobRowHtml(job: AppliedJobRecord, index: number): string {
  const title = escapeHtml(job.title || `Job ${index}`);
  const company = escapeHtml(job.company || 'N/A');
  const jd = escapeHtml(shortJd(job.jd, 180));
  return (
    `<p><b>${index}. ${title}</b> — ${company}</p>` +
    `<p style="margin:4px 0 12px;color:#555;">${jd}</p>`
  );
}

function buildLoopOverviewHtml(loop: number, jobs: AppliedJobRecord[]): string {
  return buildOverviewFromJobs(toCsvRows(jobs)).descriptionHtml.replace(
    '<h3>Applied Jobs (from CSV)</h3>',
    `<h4>Loop ${loop}</h4>`,
  );
}
