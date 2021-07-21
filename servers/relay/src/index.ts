import * as Sentry from "@sentry/node";
import { LogLevel as SentryLogLevel } from "@sentry/types";
import config from "./config";
import { HttpService } from "./http";


function initSentry() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    debug: config.debug,
    logLevel: SentryLogLevel.Error,
    maxBreadcrumbs: 30,
  })
}
initSentry()

const httpService = new HttpService({
  logger: config.debug ? "debug" : "warn",
})
const app = httpService.app

// Due to Pino Sentry has init Sentry the 2nd time.
// We need to init the 3rd time to override the empty config.
initSentry()

async function onCloseSignal(signal) {
  console.info(`Signal ${signal} received.`)
  console.log('App is being closed...')

  const closeErr = await app.close()
  if (closeErr) {
    console.log('Close app failed with error:', closeErr)
  }

  console.log("Sentry flush in 2s...")
  const flushOK = await Sentry.flush(2000)
  if (!flushOK) {
    console.log("Sentry flush failed")
  }
  console.log('App has been closed!')

  process.exit(closeErr ? 1 : 0)
}

process.on('SIGTERM', onCloseSignal)
process.on('SIGINT', onCloseSignal)

httpService.initialize().then(() => {
  app.listen(+config.port, config.host, (err, address) => {
    if (!config.debug) app.log.info(`Server listening on ${address}`);
    if (err) throw err;
  })
})
