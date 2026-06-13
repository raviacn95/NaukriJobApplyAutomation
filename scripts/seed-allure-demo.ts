/** Creates a demo Allure run in reports/allure-history for testing GitHub Pages publish. */
import { NaukriAllureReporter, AppliedJobRecord } from '../src/allure-reporter';

function demoJob(loop: number, batchIndex: number): AppliedJobRecord {
  return {
    title: `Software Engineer ${batchIndex}`,
    company: `Demo Company ${batchIndex}`,
    location: 'Remote',
    experience: '3-5 years',
    salary: 'Not disclosed',
    jd: 'Sample job description for Allure report verification.',
    jobUrl: 'https://www.naukri.com/',
    loop,
    batchIndex,
    appliedAt: new Date().toISOString(),
    status: 'applied',
  };
}

const reporter = new NaukriAllureReporter({ shard: '1/1', totalLoops: 2, jobsPerLoop: 3 });

for (let loop = 1; loop <= 2; loop++) {
  const jobs = [1, 2, 3].map((i) => demoJob(loop, i));
  reporter.recordLoop(loop, 2, 3, false, jobs);
}

reporter.finishRun(6);
console.log(`Demo Allure run archived: ${reporter.runId}`);
