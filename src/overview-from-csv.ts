export interface CsvJobRow {
  loop: string;
  batchIndex: string;
  title: string;
  company: string;
  location: string;
  experience: string;
  salary: string;
  jobUrl: string;
  appliedAt: string;
  status: string;
  jd: string;
}

export function shortJd(jd: string, max = 160): string {
  const text = String(jd ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'No description captured.';
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Parse All Applied Jobs CSV (handles quoted fields). */
export function parseAppliedJobsCsv(csv: string): CsvJobRow[] {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const idx = (name: string) => headers.indexOf(name);

  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const pick = (name: string) => cols[idx(name)] ?? '';
    return {
      loop: pick('loop'),
      batchIndex: pick('batchIndex'),
      title: pick('title'),
      company: pick('company'),
      location: pick('location'),
      experience: pick('experience'),
      salary: pick('salary'),
      jobUrl: pick('jobUrl'),
      appliedAt: pick('appliedAt'),
      status: pick('status'),
      jd: pick('jd'),
    };
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function buildOverviewFromJobs(
  jobs: CsvJobRow[],
  totalApplied?: number,
): {
  descriptionHtml: string;
  description: string;
  parameters: { name: string; value: string }[];
} {
  const count = totalApplied ?? jobs.length;
  const applied = jobs.filter((j) => j.status === 'applied').length;
  const total = count || applied || jobs.length;

  const rows = jobs
    .map(
      (j, i) =>
        `<tr>` +
        `<td style="padding:8px;border:1px solid #ccc;">${i + 1}</td>` +
        `<td style="padding:8px;border:1px solid #ccc;"><b>${escapeHtml(j.title || `Job ${i + 1}`)}</b></td>` +
        `<td style="padding:8px;border:1px solid #ccc;">${escapeHtml(j.company || 'N/A')}</td>` +
        `<td style="padding:8px;border:1px solid #ccc;">${escapeHtml(j.experience || 'N/A')}</td>` +
        `<td style="padding:8px;border:1px solid #ccc;">${escapeHtml(j.salary || 'N/A')}</td>` +
        `<td style="padding:8px;border:1px solid #ccc;">${escapeHtml(shortJd(j.jd, 180))}</td>` +
        `</tr>`,
    )
    .join('');

  const descriptionHtml =
    `<h3>Applied Jobs (from CSV)</h3>` +
    `<p><b>Total jobs applied:</b> ${total}</p>` +
    `<table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:8px;">` +
    `<thead><tr>` +
    `<th style="padding:8px;border:1px solid #ccc;text-align:left;">#</th>` +
    `<th style="padding:8px;border:1px solid #ccc;text-align:left;">Job</th>` +
    `<th style="padding:8px;border:1px solid #ccc;text-align:left;">Company</th>` +
    `<th style="padding:8px;border:1px solid #ccc;text-align:left;">Experience</th>` +
    `<th style="padding:8px;border:1px solid #ccc;text-align:left;">Salary</th>` +
    `<th style="padding:8px;border:1px solid #ccc;text-align:left;">Short JD</th>` +
    `</tr></thead><tbody>${rows || '<tr><td colspan="6">No jobs in CSV</td></tr>'}</tbody></table>`;

  const descriptionLines = jobs.map(
    (j, i) =>
      `${i + 1}. ${j.title || 'Unknown'} @ ${j.company || 'Unknown'} | ${j.salary || 'N/A'} | ${shortJd(j.jd, 100)}`,
  );

  const description =
    `Total jobs applied: ${total}\n\n` + (descriptionLines.length ? descriptionLines.join('\n') : 'No jobs recorded.');

  const parameters: { name: string; value: string }[] = [
    { name: 'totalJobsApplied', value: String(total) },
    { name: 'jobsListedInCsv', value: String(jobs.length) },
  ];

  jobs.forEach((j, i) => {
    parameters.push({
      name: `Job ${i + 1}`,
      value: `${j.title || 'Unknown'} @ ${j.company || 'Unknown'} — ${shortJd(j.jd, 140)}`,
    });
  });

  return { descriptionHtml, description, parameters };
}
