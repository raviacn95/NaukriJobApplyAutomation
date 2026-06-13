export interface JobTargetConfig {
  experienceYears: number;
  minExperienceYears: number;
  maxExperienceYears: number;
  minSalaryLpa: number;
  maxSalaryLpa: number;
  allowUndisclosedSalary: boolean;
  searchKeyword?: string;
}

export const DEFAULT_JOB_TARGET: JobTargetConfig = {
  experienceYears: 8,
  minExperienceYears: 6,
  maxExperienceYears: 14,
  minSalaryLpa: 18,
  maxSalaryLpa: 35,
  allowUndisclosedSalary: true,
};

export function loadJobTarget(raw: Partial<JobTargetConfig> | undefined): JobTargetConfig {
  return {
    experienceYears: raw?.experienceYears ?? DEFAULT_JOB_TARGET.experienceYears,
    minExperienceYears: raw?.minExperienceYears ?? DEFAULT_JOB_TARGET.minExperienceYears,
    maxExperienceYears: raw?.maxExperienceYears ?? DEFAULT_JOB_TARGET.maxExperienceYears,
    minSalaryLpa: raw?.minSalaryLpa ?? DEFAULT_JOB_TARGET.minSalaryLpa,
    maxSalaryLpa: raw?.maxSalaryLpa ?? DEFAULT_JOB_TARGET.maxSalaryLpa,
    allowUndisclosedSalary: raw?.allowUndisclosedSalary ?? DEFAULT_JOB_TARGET.allowUndisclosedSalary,
    searchKeyword: raw?.searchKeyword,
  };
}

/** Build Naukri search URL pre-filtered for experience and high salary bands. */
export function buildTargetSearchUrl(target: JobTargetConfig, baseUrl?: string): string {
  if (baseUrl && baseUrl.includes('naukri.com')) return baseUrl;

  const keyword = (target.searchKeyword || 'software engineer').trim().replace(/\s+/g, '-').toLowerCase();
  const params = new URLSearchParams();
  params.set('experience', String(target.experienceYears));
  params.append('ctcFilter', '15to25');
  params.append('ctcFilter', '25to50');
  params.set('sort', 'date');
  return `https://www.naukri.com/${keyword}-jobs?${params.toString()}`;
}

export function parseExperienceYears(text: string): { min: number; max: number } | null {
  const raw = (text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  const range = raw.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (range) {
    return { min: Number(range[1]), max: Number(range[2]) };
  }

  const single = raw.match(/(\d+)\s*(\+?\s*(?:yrs?|years?))?/i);
  if (single) {
    const n = Number(single[1]);
    if (single[0].includes('+')) return { min: n, max: n + 5 };
    return { min: n, max: n };
  }

  return null;
}

export function parseSalaryLpa(text: string): { min: number; max: number } | null {
  const raw = (text || '').replace(/\s+/g, ' ').trim();
  if (!raw || /not disclosed|n\/a|un disclosed/i.test(raw)) return null;

  const rangeLac = raw.match(/(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*(?:lac|lakh|lpa|lacs?)/i);
  if (rangeLac) {
    return { min: Number(rangeLac[1]), max: Number(rangeLac[2]) };
  }

  const singleLac = raw.match(/(\d+(?:\.\d+)?)\s*(?:lac|lakh|lpa|lacs?)\b/i);
  if (singleLac) {
    const n = Number(singleLac[1]);
    return { min: n, max: n };
  }

  const crore = raw.match(/(\d+(?:\.\d+)?)\s*(?:cr|crore)/i);
  if (crore) {
    const n = Number(crore[1]) * 100;
    return { min: n, max: n };
  }

  const monthly = raw.match(/(?:₹|rs\.?\s*)?(\d[\d,]*)\s*[-–to]+\s*(?:₹|rs\.?\s*)?(\d[\d,]*)/i);
  if (monthly && /month|pm|per month/i.test(raw)) {
    const min = (Number(monthly[1].replace(/,/g, '')) * 12) / 100000;
    const max = (Number(monthly[2].replace(/,/g, '')) * 12) / 100000;
    return { min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 };
  }

  return null;
}

export function matchesJobTarget(
  experienceText: string,
  salaryText: string,
  target: JobTargetConfig,
): { match: boolean; reason: string } {
  const exp = parseExperienceYears(experienceText);
  if (exp) {
    const candidate = target.experienceYears;
    const overlaps =
      candidate >= exp.min - 1 &&
      candidate <= exp.max + 1 &&
      exp.max >= target.minExperienceYears &&
      exp.min <= target.maxExperienceYears;
    if (!overlaps) {
      return {
        match: false,
        reason: `experience ${experienceText} outside ${target.minExperienceYears}-${target.maxExperienceYears} yrs target`,
      };
    }
  }

  const sal = parseSalaryLpa(salaryText);
  if (!sal) {
    if (target.allowUndisclosedSalary) {
      return { match: true, reason: 'salary undisclosed (allowed)' };
    }
    return { match: false, reason: 'salary not disclosed' };
  }

  const highEnough = sal.max >= target.minSalaryLpa;
  const withinCap = sal.min <= target.maxSalaryLpa;
  if (highEnough && withinCap) {
    return { match: true, reason: `salary ${salaryText} in ${target.minSalaryLpa}-${target.maxSalaryLpa} LPA band` };
  }

  return {
    match: false,
    reason: `salary ${salaryText} outside ${target.minSalaryLpa}-${target.maxSalaryLpa} LPA`,
  };
}
