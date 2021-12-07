import { CaptureConsole } from "@sentry/integrations";
import * as Sentry from "@sentry/node";
import { LogLevel as SentryLogLevel } from "@sentry/types";
import config from "./config";
import { HttpService } from "./http";


const httpService = new HttpService({
  logger: config.logLevel,
})
const { app, ws } = httpService

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  debug: config.logLevel == "debug",
  logLevel: SentryLogLevel.Error,
  integrations: [
    new CaptureConsole({ levels: ["warn"] }),
  ],
  maxBreadcrumbs: 30,
  tracesSampleRate: 0.35,
})


let isStopping = false
async function onCloseSignal(signal) {
  if (isStopping) {
    return
  }
  isStopping = true

  console.info(`Signal ${signal} received.`)
  console.log('App is being closed...')

  setTimeout(() => {
    console.log('App has been force closed!')
    process.exit(1)
  }, 10000).unref()
  const [closeErr, _] = await Promise.all([app.close(), ws.close()])
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
    if (err) throw err;
    console.info(`App is running on ${address}`)
  })
})
