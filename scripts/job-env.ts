// Cloud Run Jobs do not serve HTTP or receive a PORT. Only the job bundle uses this shim.
export const env = { ...process.env, NTS_CATALOG_JOB: '1' };
