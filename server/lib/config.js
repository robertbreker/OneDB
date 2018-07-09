const FIFTEEN_MIN = 15 * 60 * 1000;

module.exports = {
  maxDataSize: '1000kb',
  rateLimit: {
    all: {
      windowMs: FIFTEEN_MIN,
      max: 900,
      delayMs: 0,
    },
    createUser: {
      windowMS: FIFTEEN_MIN,
      max: 5,
      delayMs: 3 * 1000,
      delayAfter: 1,
    },
    getData: {  // 1 qps
      windowMS: FIFTEEN_MIN,
      max: 900,
      delayMs: 0,
    },
    mutateData: { // .25 qps
      windowMS: FIFTEEN_MIN,
      max: 225,
      delayMs: 500,
      delayAfter: 100,
    },
  }
}
